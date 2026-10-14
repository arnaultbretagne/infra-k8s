"""Tests for the Git-owned custom components, run in a real Home Assistant core.

From apps/home-assistant, with Python 3.14 and the plugin release that pins the image's HA version
(0.13.371 = homeassistant 2026.10.0), plus the webostv requirement:

    pip install pytest-homeassistant-custom-component==0.13.371 aiowebostv==0.10.0
    python -m pytest tests
"""

import pytest

# Import ours first: HA later puts the plugin's own testing_config (which has a custom_components
# package) in front of sys.path, and the loader imports whichever `custom_components` is cached.
import custom_components.webostv_keyboard  # noqa: F401

pytest_plugins = "pytest_homeassistant_custom_component"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Load custom_components/ from this directory."""
    return
