"""One binary sensor per LG webOS TV: on while a text field is focused on the TV."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from aiowebostv import WebOsClient, WebOsTvState

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.config_entries import (
    SIGNAL_CONFIG_ENTRY_CHANGED,
    ConfigEntry,
    ConfigEntryChange,
    ConfigEntryState,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType
from homeassistant.util import slugify

from .const import DOMAIN, ENTER_KEYS, IME_DELETE, IME_ENTER, IME_INSERT, IME_SUBSCRIBE, WEBOSTV

_LOGGER = logging.getLogger(__name__)


async def async_setup_platform(
    hass: HomeAssistant,
    config: ConfigType,
    async_add_entities: AddEntitiesCallback,
    discovery_info: DiscoveryInfoType | None = None,
) -> None:
    """Add a keyboard per webostv config entry and keep it on that entry's current client."""
    if discovery_info is None:
        return
    keyboards: dict[str, TvKeyboard] = {}  # by webostv config entry id

    @callback
    def follow(entry: ConfigEntry) -> None:
        if (keyboard := keyboards.get(entry.entry_id)) is None:
            keyboard = keyboards[entry.entry_id] = TvKeyboard(hass, entry)
            async_add_entities([keyboard])
        keyboard.async_attach(_client(entry))

    @callback
    def entry_changed(change: ConfigEntryChange, entry: ConfigEntry) -> None:
        # Fires on every state change of every entry: a webostv reload brings a new client.
        if entry.domain != WEBOSTV:
            return
        if change is ConfigEntryChange.REMOVED:
            if keyboard := keyboards.get(entry.entry_id):
                keyboard.async_attach(None)
            return
        follow(entry)

    for entry in hass.config_entries.async_entries(
        WEBOSTV, include_ignore=False, include_disabled=False
    ):
        follow(entry)
    async_dispatcher_connect(hass, SIGNAL_CONFIG_ENTRY_CHANGED, entry_changed)


def _client(entry: ConfigEntry) -> WebOsClient | None:
    """The webostv integration's own client for this TV (runtime_data.client), while loaded."""
    if entry.state is not ConfigEntryState.LOADED:
        return None
    client = getattr(getattr(entry, "runtime_data", None), "client", None)
    if not callable(getattr(client, "register_state_update_callback", None)):
        _LOGGER.error(
            "webostv entry %s has no aiowebostv client in runtime_data.client: the webostv "
            "integration changed, %s needs an update",
            entry.title,
            DOMAIN,
        )
        return None
    return client


def _tv_name(hass: HomeAssistant, entry: ConfigEntry) -> tuple[str, str]:
    """Object id and display name of the TV's media player, else of the entry."""
    registry = er.async_get(hass)
    player = next(
        (e for e in er.async_entries_for_config_entry(registry, entry.entry_id) if e.domain == "media_player"),
        None,
    )
    if player is None:
        return slugify(entry.title), entry.title
    device = dr.async_get(hass).async_get(player.device_id) if player.device_id else None
    name = (
        player.name
        or player.original_name
        or (device and (device.name_by_user or device.name))
        or entry.title
    )
    return player.entity_id.split(".", 1)[1], name


class TvKeyboard(BinarySensorEntity):
    """On while a text field is focused on the TV; `async_edit` types into that field."""

    _attr_should_poll = False
    _attr_icon = "mdi:keyboard"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Name the sensor after the TV's media player: media_player.salon_tv -> binary_sensor.salon_tv_keyboard."""
        object_id, name = _tv_name(hass, entry)
        self.entity_id = f"binary_sensor.{object_id}_keyboard"
        self._attr_unique_id = f"{entry.unique_id or entry.entry_id}_keyboard"
        self._attr_name = f"Clavier {name}"
        self._attr_is_on = False
        self._attr_extra_state_attributes = {}
        self._added = False
        self._wanted: WebOsClient | None = None
        self._client: WebOsClient | None = None
        self._connection: object | None = None  # the client websocket our subscription lives on
        self._widget: dict[str, Any] = {}  # latest currentWidget while a field is focused
        self._field = 0  # counts focused fields, so the card can tell one field from the next
        self._lock = asyncio.Lock()

    async def async_added_to_hass(self) -> None:
        """Start following the TV."""
        self.hass.data[DOMAIN][self.entity_id] = self
        self._added = True
        self.async_attach(self._wanted)

    async def async_will_remove_from_hass(self) -> None:
        """Stop following the TV."""
        self._added = False
        self.hass.data[DOMAIN].pop(self.entity_id, None)
        self._detach()

    @callback
    def async_attach(self, client: WebOsClient | None) -> None:
        """Follow this client (the webostv entry's current one), or none while it is not loaded."""
        self._wanted = client
        if not self._added or client is self._client:
            return
        self._detach()
        self._client = client
        if client is not None:
            # Called back at once when connected, then at every (re)connection and disconnection.
            self.hass.async_create_background_task(
                client.register_state_update_callback(self._async_tv_state),
                f"{DOMAIN} attach {self.entity_id}",
            )

    @callback
    def _detach(self) -> None:
        if self._client is not None:
            self._client.unregister_state_update_callback(self._async_tv_state)
        self._client = None
        self._connection = None
        self._show({}, new_field=False)

    async def _async_tv_state(self, _tv_state: WebOsTvState) -> None:
        """aiowebostv calls this on every state change, connection and disconnection of the TV."""
        client = self._client
        if client is None:
            return
        connection = client.connection
        if connection is None:
            self._connection = None
            self._show({}, new_field=False)
        elif connection is not self._connection and client.do_state_update:
            # A new connection: aiowebostv drops every subscription when a connection ends.
            self._connection = connection
            self.hass.async_create_background_task(
                self._async_subscribe(client, connection), f"{DOMAIN} subscribe {self.entity_id}"
            )

    async def _async_subscribe(self, client: WebOsClient, connection: object) -> None:
        try:
            await client.subscribe(self._async_keyboard, IME_SUBSCRIBE)
        except asyncio.CancelledError:
            if client.connection is connection:
                raise  # we are being cancelled, not the connection
            # the connection ended before the TV answered: the next one subscribes again
        except Exception as err:  # noqa: BLE001 - never let this break the webostv connection
            if client.connection is connection:
                _LOGGER.warning("%s: the TV does not report its text fields (%r)", self.entity_id, err)

    async def _async_keyboard(self, payload: dict[str, Any] | None) -> None:
        """The TV's remote keyboard update: the subscription's answer, then one per field change."""
        payload = payload or {}
        self._show(
            payload.get("currentWidget") or {},
            new_field=bool(payload.get("focusChanged")) or not self._attr_is_on,
        )

    @callback
    def _show(self, widget: dict[str, Any], *, new_field: bool) -> None:
        focus = bool(widget.get("focus"))
        if focus and new_field:
            self._field += 1
        self._widget = widget if focus else {}
        self._attr_is_on = focus
        self._attr_extra_state_attributes = self._attributes() if focus else {}
        if self._added:
            self.async_write_ha_state()  # a no-op when nothing the card reads changed

    def _attributes(self) -> dict[str, Any]:
        widget = self._widget
        enter = widget.get("enterKeyType")
        return {
            "field": self._field,
            "content_type": widget.get("contentType", "text"),  # text number phonenumber email url
            "password": bool(widget.get("hiddenText")),
            "has_text": bool(widget.get("hasSurroundingText")),
            "capitalize": bool(widget.get("autoCapitalizationEnabled")),
            "enter_key": ENTER_KEYS[enter] if isinstance(enter, int) and 0 <= enter < len(ENTER_KEYS) else "default",
        }

    async def async_edit(
        self, *, clear: bool = False, delete: int = 0, text: str = "", enter: bool = False
    ) -> None:
        """Clear the field, press Backspace `delete` times, insert `text`, press Enter, in order.

        Only while a field is focused: outside one, a Backspace reaches the app as a key and
        some apps treat it as Back.
        """
        client = self._client
        if client is None or client.connection is None or not self._attr_is_on:
            raise HomeAssistantError("No text field is open on the TV")
        async with self._lock:  # edits from fast typing must reach the TV in order
            if clear:
                await self._async_clear(client)
            if delete:
                # Real Backspace presses: the IME's other delete mode miscounts multi-byte
                # characters (é, à...), per its own source.
                await client.request(IME_DELETE, {"count": delete})
            if text:
                await client.request(IME_INSERT, {"text": text, "replace": False})
            if enter:
                await client.request(IME_ENTER)

    async def _async_clear(self, client: WebOsClient) -> None:
        widget = self._widget
        if widget.get("hasSurroundingText") is False:
            return
        if widget.get("hiddenText") or "cursorPosition" not in widget:
            # A password field hides its cursor and length: replace the whole text with nothing.
            await client.request(IME_INSERT, {"text": "", "replace": True})
        elif count := widget["cursorPosition"]:
            await client.request(IME_DELETE, {"count": count})
