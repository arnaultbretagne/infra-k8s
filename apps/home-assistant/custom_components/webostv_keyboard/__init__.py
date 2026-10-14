"""Tells Home Assistant when an LG webOS TV shows a text field, and types into it from the phone.

webOS reports the focused text field to every "remote keyboard" (SSAP
com.webos.service.ime/registerRemoteKeyboard, the API LG's own phone app uses): whether a field is
focused, whether it is a password, its content type, the label of its Enter key, the cursor and
the text length — never the text itself. Registering only adds a listener to webOS's IME service
(maliit-framework-webos imelunaservice.cpp): nothing there hides the TV's own on-screen keyboard.

The binary_sensor platform subscribes on the webostv integration's own connection and exposes one
`binary_sensor.<tv>_keyboard` per TV, on while a text field is focused. The websocket command
`webostv_keyboard/edit` types into that field: clear, backspaces, text, then Enter, in that order.

Typing goes through a websocket command, not a service, on purpose: the recorder stores every
service call with its data in the events table, and a password typed from the phone must not
land there.

Git-owned: apps/home-assistant/custom_components/webostv_keyboard in infra-k8s (README.md, "LG TV
remote"); enabled by `webostv_keyboard:` in configuration.yaml.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from aiohttp import ClientError
from aiowebostv import WebOsTvCommandError
import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv, discovery
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN

if TYPE_CHECKING:
    from .binary_sensor import TvKeyboard

CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)

# One edit never carries more than what fits in a TV text field.
MAX_EDIT = 1000


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the edit command and load the keyboard sensors."""
    hass.data[DOMAIN] = {}  # entity_id -> TvKeyboard, filled by the binary_sensor platform
    websocket_api.async_register_command(hass, ws_edit)
    hass.async_create_task(
        discovery.async_load_platform(hass, Platform.BINARY_SENSOR, DOMAIN, {}, config)
    )
    return True


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/edit",
        vol.Required("entity_id"): cv.entity_id,
        vol.Optional("clear", default=False): cv.boolean,
        vol.Optional("delete", default=0): vol.All(vol.Coerce(int), vol.Range(min=0, max=MAX_EDIT)),
        vol.Optional("text", default=""): vol.All(str, vol.Length(max=MAX_EDIT)),
        vol.Optional("enter", default=False): cv.boolean,
    }
)
@websocket_api.async_response
async def ws_edit(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Edit the focused text field of a TV: clear it, delete, insert text, press Enter."""
    keyboard: TvKeyboard | None = hass.data[DOMAIN].get(msg["entity_id"])
    if keyboard is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "No such TV keyboard")
        return
    try:
        await keyboard.async_edit(
            clear=msg["clear"], delete=msg["delete"], text=msg["text"], enter=msg["enter"]
        )
    except (HomeAssistantError, WebOsTvCommandError, ClientError, TimeoutError) as err:
        connection.send_error(msg["id"], websocket_api.ERR_HOME_ASSISTANT_ERROR, str(err) or repr(err))
        return
    connection.send_result(msg["id"])
