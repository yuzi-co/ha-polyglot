"""Translation storage, kept in .storage/polyglot.translations."""

from __future__ import annotations

from collections.abc import Callable
import re
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store

from .const import KEY_PREFIXES, MAX_VALUE_LENGTH, STORAGE_KEY, STORAGE_VERSION

SAVE_DELAY = 2


class PolyglotStore:
    """Languages and their translations: {"languages": [...], "translations": {lang: {key: text}}}."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.languages: list[str] = []
        self.translations: dict[str, dict[str, str]] = {}
        self._listeners: list[Callable[[], None]] = []

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.languages = list(data.get("languages", []))
        self.translations = {lang: dict(values) for lang, values in data.get("translations", {}).items()}

    @property
    def primary(self) -> str:
        """The language the original names are written in: the system language."""
        return self.hass.config.language

    def as_dict(self) -> dict[str, Any]:
        return {
            "primary": self.primary,
            "languages": self.languages,
            "translations": {lang: self.translations.get(lang, {}) for lang in self.languages},
        }

    @callback
    def async_listen(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(listener)

        @callback
        def remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return remove

    def _data(self) -> dict[str, Any]:
        return {"languages": self.languages, "translations": self.translations}

    async def async_flush(self) -> None:
        """Write now instead of after the save delay (the integration is unloading)."""
        await self._store.async_save(self._data())

    async def async_remove(self) -> None:
        """Delete the stored translations (the integration is being removed)."""
        await self._store.async_remove()

    @callback
    def set_languages(self, languages: list[str]) -> None:
        cleaned: list[str] = []
        for lang in languages:
            lang = validate_language(lang)
            if lang not in cleaned:
                cleaned.append(lang)
        self.languages = cleaned
        # Translations of removed languages are dropped on purpose: removing a language is the way to clear it.
        self.translations = {lang: v for lang, v in self.translations.items() if lang in cleaned}
        self._changed()

    @callback
    def set_many(self, language: str, values: dict[str, str | None]) -> None:
        language = validate_language(language)
        cleaned: dict[str, str | None] = {}
        for key, value in values.items():  # validate everything before changing anything
            validate_key(key)
            text = None if value is None else str(value).strip() or None
            if text is not None and len(text) > MAX_VALUE_LENGTH:
                raise ValueError(f"translation for {key} is longer than {MAX_VALUE_LENGTH} characters")
            cleaned[key] = text
        if language not in self.languages:
            self.languages.append(language)
        bucket = self.translations.setdefault(language, {})
        for key, text in cleaned.items():
            if text is None:
                bucket.pop(key, None)
            else:
                bucket[key] = text
        self._changed()

    @callback
    def _changed(self) -> None:
        self._store.async_delay_save(self._data, SAVE_DELAY)
        for listener in list(self._listeners):
            listener()


def validate_key(key: str) -> None:
    if not isinstance(key, str) or not key.startswith(KEY_PREFIXES) or len(key) > MAX_VALUE_LENGTH:
        raise ValueError(f"invalid key: {key!r}")


# BCP 47-style codes as Home Assistant uses them: "ru", "pt-BR", "zh-Hans", "sr-Latn".
LANGUAGE_RE = re.compile(r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$")


def validate_language(language: str) -> str:
    language = language.strip() if isinstance(language, str) else ""
    if not LANGUAGE_RE.match(language):
        raise ValueError(f"invalid language code: {language!r}")
    return language
