"""Names and messages for the operating system's key store. Keys are never saved in plain text."""

from __future__ import annotations

import sys


def key_store_name(platform_name: str | None = None) -> str:
    platform_name = platform_name or sys.platform
    if platform_name == "darwin":
        return "macOS Keychain"
    if platform_name == "win32":
        return "Windows Credential Manager"
    return "system keyring"


def key_store_unavailable(platform_name: str | None = None) -> str:
    platform_name = platform_name or sys.platform
    if platform_name == "darwin":
        return "macOS Keychain is unavailable. Unlock it in Keychain Access and retry. Keys are never saved in plain text."
    if platform_name == "win32":
        return (
            "Windows Credential Manager is unavailable. Sign in to Windows with your normal account and retry. "
            "Keys are never saved in plain text."
        )
    return (
        "No system keyring found. Growth Factory keeps keys only in a Secret Service keyring such as GNOME Keyring "
        "or KWallet. Install and unlock one (for example: sudo apt install gnome-keyring), then retry. "
        "Keys are never saved in plain text."
    )


class KeyStoreUnavailable(Exception):
    """The operating system has no usable key store; its message says how to set one up."""


def key_store_failure(action: str, error: BaseException) -> str:
    """A safe message for a failed key read/save/remove. `action` reads like 'Cannot read the Groq key from'."""
    if isinstance(error, KeyStoreUnavailable):
        return str(error)
    return f"{action} {key_store_name()}. Unlock it and retry."
