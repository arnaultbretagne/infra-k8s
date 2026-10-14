"""webostv_keyboard: the TV's text field as a binary sensor, and typing into it."""

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.const import EVENT_CALL_SERVICE, STATE_OFF, STATE_ON
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component

ENTITY = "binary_sensor.salon_tv_keyboard"
SUBSCRIBE = "com.webos.service.ime/registerRemoteKeyboard"
INSERT = "com.webos.service.ime/insertText"
DELETE = "com.webos.service.ime/deleteCharacters"
ENTER = "com.webos.service.ime/sendEnterKey"


class FakeTv:
    """The parts of aiowebostv.WebOsClient the integration uses, with its connection life cycle."""

    def __init__(self) -> None:
        self.connection = None
        self.do_state_update = False
        self.state_callbacks = []
        self.subscriptions = {}
        self.subscribe_calls = 0
        self.requests = []
        self.subscribe_error = None

    async def register_state_update_callback(self, callback):
        self.state_callbacks.append(callback)
        if self.do_state_update:
            await callback({})

    def unregister_state_update_callback(self, callback):
        if callback in self.state_callbacks:
            self.state_callbacks.remove(callback)

    async def subscribe(self, callback, uri, payload=None):
        self.subscribe_calls += 1
        if self.subscribe_error:
            raise self.subscribe_error
        self.subscriptions[uri] = callback
        first = {"subscribed": True, "currentWidget": {"focus": False}}
        await callback(first)
        return first

    async def request(self, uri, payload=None):
        self.requests.append((uri, payload))
        return {"returnValue": True}

    async def connect(self):
        """Like aiowebostv: a fresh connection without subscriptions, then the state callbacks."""
        self.connection = object()
        self.subscriptions = {}
        self.do_state_update = True
        for callback in list(self.state_callbacks):
            await callback({})

    async def drop(self):
        """Like aiowebostv's closeout: connection gone, subscriptions gone, callbacks told."""
        self.connection = None
        self.do_state_update = False
        self.subscriptions = {}
        for callback in list(self.state_callbacks):
            await callback({})

    async def keyboard(self, **payload):
        await self.subscriptions[SUBSCRIBE](payload)


@pytest.fixture
async def tvs(hass: HomeAssistant):
    """A paired webostv entry whose media player is media_player.salon_tv; each setup makes a new client."""
    clients: list[FakeTv] = []
    entry = MockConfigEntry(
        domain="webostv",
        title="LG webOS TV OLED65CX6LA",
        unique_id="afff9148-edf2-4c8d-d9dd-1f79f7f8ef08",
        data={"host": "10.10.30.110", "client_secret": "secret"},
    )
    entry.add_to_hass(hass)
    er.async_get(hass).async_get_or_create(
        "media_player", "webostv", entry.unique_id, suggested_object_id="salon_tv",
        config_entry=entry, original_name="TV",
    )

    async def setup_entry(hass, entry):
        clients.append(FakeTv())
        entry.runtime_data = SimpleNamespace(client=clients[-1])
        return True

    async def unload_entry(hass, entry):
        return True

    with (
        patch("homeassistant.components.webostv.async_setup_entry", setup_entry),
        patch("homeassistant.components.webostv.async_unload_entry", unload_entry),
    ):
        assert await async_setup_component(hass, "webostv_keyboard", {"webostv_keyboard": {}})
        await hass.async_block_till_done()
        yield clients, entry


async def _connect(hass, tv):
    await tv.connect()
    await hass.async_block_till_done()


async def _edit(hass, hass_ws_client, **fields):
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": "webostv_keyboard/edit", "entity_id": ENTITY, **fields})
    return await ws.receive_json()


async def test_named_after_the_media_player(hass, tvs) -> None:
    state = hass.states.get(ENTITY)
    assert state.state == STATE_OFF
    assert state.name == "Clavier TV"
    assert er.async_get(hass).async_get(ENTITY).unique_id == "afff9148-edf2-4c8d-d9dd-1f79f7f8ef08_keyboard"


async def test_subscribes_once_connected_and_reports_the_field(hass, tvs) -> None:
    (tv,), _ = tvs
    assert tv.subscribe_calls == 0  # the TV is off
    await _connect(hass, tv)
    assert tv.subscribe_calls == 1
    assert hass.states.get(ENTITY).state == STATE_OFF

    await tv.keyboard(focusChanged=True, currentWidget={
        "focus": True, "contentType": "url", "hiddenText": False, "hasSurroundingText": True,
        "autoCapitalizationEnabled": False, "enterKeyType": 5, "cursorPosition": 4,
        "surroundingTextLength": 4,
    })
    state = hass.states.get(ENTITY)
    assert state.state == STATE_ON
    assert state.attributes["field"] == 1
    assert state.attributes["content_type"] == "url"
    assert state.attributes["enter_key"] == "search"
    assert state.attributes["has_text"] is True
    assert state.attributes["password"] is False
    assert "cursorPosition" not in state.attributes  # cursor moves stay internal

    # Typing moves the cursor: the field stays the same one.
    await tv.keyboard(focusChanged=False, currentWidget={"focus": True, "hasSurroundingText": True, "cursorPosition": 5})
    assert hass.states.get(ENTITY).attributes["field"] == 1
    # Another field: a new number, so the card starts afresh.
    await tv.keyboard(focusChanged=True, currentWidget={"focus": True, "hiddenText": True})
    state = hass.states.get(ENTITY)
    assert state.attributes["field"] == 2
    assert state.attributes["password"] is True
    assert state.attributes["enter_key"] == "default"

    await tv.keyboard(focusChanged=True, currentWidget={"focus": False})
    state = hass.states.get(ENTITY)
    assert state.state == STATE_OFF
    assert "field" not in state.attributes


async def test_disconnection_turns_off_and_reconnection_subscribes_again(hass, tvs) -> None:
    (tv,), _ = tvs
    await _connect(hass, tv)
    await tv.keyboard(focusChanged=True, currentWidget={"focus": True})
    assert hass.states.get(ENTITY).state == STATE_ON

    await tv.drop()
    await hass.async_block_till_done()
    assert hass.states.get(ENTITY).state == STATE_OFF

    await _connect(hass, tv)
    assert tv.subscribe_calls == 2
    # Other TV updates on the same connection do not subscribe again.
    for callback in tv.state_callbacks:
        await callback({})
    await hass.async_block_till_done()
    assert tv.subscribe_calls == 2


async def test_follows_the_new_client_after_a_webostv_reload(hass, tvs) -> None:
    clients, entry = tvs
    await _connect(hass, clients[0])
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert len(clients) == 2
    old, new = clients
    assert old.state_callbacks == []  # let go of the old client
    await _connect(hass, new)
    assert new.subscribe_calls == 1
    await new.keyboard(focusChanged=True, currentWidget={"focus": True})
    assert hass.states.get(ENTITY).state == STATE_ON


async def test_a_tv_without_the_api_only_logs(hass, tvs, caplog) -> None:
    (tv,), _ = tvs
    tv.subscribe_error = RuntimeError("404 no such service or method")
    await _connect(hass, tv)
    assert "does not report its text fields" in caplog.text
    assert hass.states.get(ENTITY).state == STATE_OFF


async def test_edit_reaches_the_tv_in_order_and_is_not_recorded(hass, tvs, hass_ws_client) -> None:
    (tv,), _ = tvs
    await _connect(hass, tv)
    await tv.keyboard(focusChanged=True, currentWidget={"focus": True, "hasSurroundingText": True, "cursorPosition": 3})
    service_calls = []
    hass.bus.async_listen(EVENT_CALL_SERVICE, service_calls.append)

    msg = await _edit(hass, hass_ws_client, clear=True, delete=2, text="Amélie", enter=True)
    assert msg["success"], msg
    assert tv.requests == [
        (DELETE, {"count": 3}),
        (DELETE, {"count": 2}),
        (INSERT, {"text": "Amélie", "replace": False}),
        (ENTER, None),
    ]
    assert service_calls == []  # nothing typed lands in the recorder's events


async def test_clearing_a_password_replaces_its_text(hass, tvs, hass_ws_client) -> None:
    (tv,), _ = tvs
    await _connect(hass, tv)
    await tv.keyboard(focusChanged=True, currentWidget={"focus": True, "hiddenText": True, "hasSurroundingText": True})
    assert (await _edit(hass, hass_ws_client, clear=True))["success"]
    assert tv.requests == [(INSERT, {"text": "", "replace": True})]

    tv.requests.clear()
    await tv.keyboard(focusChanged=True, currentWidget={"focus": True, "hasSurroundingText": False})
    assert (await _edit(hass, hass_ws_client, clear=True))["success"]
    assert tv.requests == []  # already empty


async def test_no_edit_without_a_focused_field(hass, tvs, hass_ws_client) -> None:
    (tv,), _ = tvs
    msg = await _edit(hass, hass_ws_client, text="a")  # TV off
    assert not msg["success"]
    await _connect(hass, tv)
    msg = await _edit(hass, hass_ws_client, delete=1)  # on, no field: a Backspace could act as Back
    assert not msg["success"]
    assert msg["error"]["message"] == "No text field is open on the TV"
    assert tv.requests == []

    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": "webostv_keyboard/edit", "entity_id": "binary_sensor.nope", "text": "a"})
    assert (await ws.receive_json())["error"]["code"] == "not_found"
