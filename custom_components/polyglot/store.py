"""Translation storage, kept in .storage/polyglot.translations."""

from __future__ import annotations

from collections.abc import Callable
import re
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store

from .const import DOMAIN, KEY_PREFIXES, MAX_VALUE_LENGTH, STORAGE_KEY, STORAGE_VERSION

SAVE_DELAY = 2


class PolyglotStore:
    """Languages, their translations and settings:
    {"languages": [...], "translations": {lang: {key: text}}, "auto_names": bool}."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.languages: list[str] = []
        self.translations: dict[str, dict[str, str]] = {}
        # Show Home Assistant's own entity names in each user's language where there is no translation here.
        self.auto_names = False
        # Kept in hass.data, not on the store: subscriptions of open pages outlive a reload of the integration,
        # which makes a new store.
        self._listeners: list[Callable[[str | None], None]] = hass.data.setdefault(f"{DOMAIN}_listeners", [])

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.languages = list(data.get("languages", []))
        self.translations = {lang: dict(values) for lang, values in data.get("translations", {}).items()}
        self.auto_names = bool(data.get("auto_names", False))

    @property
    def primary(self) -> str:
        """The language the original names are written in: the system language."""
        return self.hass.config.language

    def as_dict(self, only: str | None = None) -> dict[str, Any]:
        """Everything, or (with `only`) the language list and that one language's translations."""
        languages = self.languages if only is None else [lang for lang in self.languages if lang == only]
        return {
            "primary": self.primary,
            "languages": self.languages,
            "translations": {lang: self.translations.get(lang, {}) for lang in languages},
            "auto_names": self.auto_names,
        }

    def pick(self, user_language: str | None) -> str | None:
        """The dictionary a user with this profile language gets, or None for the original names."""
        return pick_language(user_language, self.primary, self.languages)

    @callback
    def async_notify(self, language: str | None = None) -> None:
        """Tell subscribers that `language` changed; None means anything may have (languages added or removed,
        the integration loaded or unloaded)."""
        for listener in list(self._listeners):
            listener(language)

    def _data(self) -> dict[str, Any]:
        return {"languages": self.languages, "translations": self.translations, "auto_names": self.auto_names}

    async def async_flush(self) -> None:
        """Write now instead of after the save delay (the integration is unloading)."""
        await self._store.async_save(self._data())

    async def async_remove(self) -> None:
        """Delete the stored translations (the integration is being removed)."""
        await self._store.async_remove()

    @callback
    def set_auto_names(self, enabled: bool) -> None:
        self.auto_names = bool(enabled)
        self._changed(None)

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
        self._changed(None)

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
        added = language not in self.languages
        if added:
            self.languages.append(language)
        bucket = self.translations.setdefault(language, {})
        for key, text in cleaned.items():
            if text is None:
                bucket.pop(key, None)
            else:
                bucket[key] = text
        self._changed(None if added else language)

    @callback
    def _changed(self, language: str | None) -> None:
        self._store.async_delay_save(self._data, SAVE_DELAY)
        self.async_notify(language)


@callback
def async_listen(hass: HomeAssistant, listener: Callable[[str | None], None]) -> Callable[[], None]:
    """Call `listener(language)` after every change. Works whether or not the integration is loaded right now."""
    listeners: list[Callable[[str | None], None]] = hass.data.setdefault(f"{DOMAIN}_listeners", [])
    listeners.append(listener)

    @callback
    def remove() -> None:
        if listener in listeners:
            listeners.remove(listener)

    return remove


def pick_language(user_language: str | None, primary: str, available: list[str]) -> str | None:
    """Same rule as pickLanguage in frontend/core.js: an exact match, else the same base language, and never a
    dictionary for someone whose language is the one the names are written in."""
    if not user_language:
        return None
    if user_language in available:
        return user_language

    def base(language: str) -> str:
        return language.lower().split("-")[0]

    if base(user_language) == base(primary):
        return None
    return next((lang for lang in available if base(lang) == base(user_language)), None)


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
