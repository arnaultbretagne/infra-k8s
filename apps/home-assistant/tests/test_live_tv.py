"""webostv_keyboard against the real TV, through the real webostv integration and aiowebostv.

Skipped unless WEBOSTV_HOST and WEBOSTV_KEY (the client key of the webostv config entry) are set;
the TV must be on and reachable (from g4: the router lets 10.10.20.10 reach 10.10.30.110:3001).
Read-only: it subscribes, drops the connection and checks that the next one subscribes again;
it types nothing.
"""

import asyncio
import os

import pytest
import pytest_socket
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import STATE_OFF
from homeassistant.setup import async_setup_component

HOST = os.environ.get("WEBOSTV_HOST")
KEY = os.environ.get("WEBOSTV_KEY")
SUBSCRIBE = "com.webos.service.ime/registerRemoteKeyboard"

pytestmark = pytest.mark.skipif(not (HOST and KEY), reason="needs WEBOSTV_HOST and WEBOSTV_KEY")


async def _until(predicate, timeout=15):
    for _ in range(int(timeout * 10)):
        if predicate():
            return True
        await asyncio.sleep(0.1)
    return False


async def test_subscribes_on_the_real_tv_and_again_after_a_reconnection(hass, socket_enabled) -> None:
    pytest_socket.socket_allow_hosts([HOST, "127.0.0.1"])
    entry = MockConfigEntry(
        domain="webostv", title="Live TV", unique_id="live-tv",
        data={"host": HOST, "client_secret": KEY},
    )
    entry.add_to_hass(hass)
    assert await async_setup_component(hass, "webostv_keyboard", {"webostv_keyboard": {}})
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    coordinator = entry.runtime_data
    client = coordinator.client
    entity = "binary_sensor.live_tv_keyboard"  # no media player registered: named after the entry

    try:
        assert client.is_connected(), "TV off or unreachable"
        assert await _until(lambda: SUBSCRIBE in client._subscriptions), "never subscribed"
        # aiowebostv numbers messages from 0 on every connection: tell subscriptions apart by
        # their handler task, which each connection creates anew.
        first = client.callback_tasks[client._subscriptions[SUBSCRIBE]]
        assert hass.states.get(entity) is not None
        print("state after connection:", hass.states.get(entity).state, hass.states.get(entity).attributes)

        await client.disconnect()
        await hass.async_block_till_done()
        assert hass.states.get(entity).state == STATE_OFF
        await coordinator.async_refresh()  # what webostv's 10 s poll does when disconnected
        assert client.is_connected()
        assert await _until(
            lambda: SUBSCRIBE in client._subscriptions
            and client.callback_tasks.get(client._subscriptions[SUBSCRIBE]) not in (None, first)
        ), "not subscribed again after the reconnection"
        print("state after reconnection:", hass.states.get(entity).state)
    finally:
        await client.disconnect()
