"""Constants for the LG webOS TV keyboard integration."""

DOMAIN = "webostv_keyboard"
WEBOSTV = "webostv"

# SSAP methods of the TV's input method service (aiowebostv adds the ssap:// scheme itself).
IME_SUBSCRIBE = "com.webos.service.ime/registerRemoteKeyboard"
IME_INSERT = "com.webos.service.ime/insertText"
IME_DELETE = "com.webos.service.ime/deleteCharacters"
IME_ENTER = "com.webos.service.ime/sendEnterKey"

# currentWidget.enterKeyType is Maliit::EnterKeyType, in this order (maliit/namespace.h).
ENTER_KEYS = ("default", "return", "done", "go", "send", "search", "next", "previous")
