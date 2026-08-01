# Murmur Support

Murmur is a BLE shell/agent client for headless Raspberry Pi devices, developed by nekonihq.

## Getting help

- **Report a bug or request a feature:** open an issue at
  [github.com/nekonihq/murmur/issues](https://github.com/nekonihq/murmur/issues).
- **Email support:** denys@malykhin.dev

## Frequently asked questions

**The app can't find my Pi during pairing.**
Make sure `murmurd` is running on the Pi (`systemctl status murmurd`) and that Bluetooth is
enabled on both the Pi and your phone. The Pi must be within BLE range (a few meters) and not
already paired with another phone.

**Does murmur send my data anywhere?**
No. Murmur has no backend server. The only network traffic it generates is the LLM API calls
you make with your own API key when using Agent mode. See the
[Privacy Policy](https://github.com/nekonihq/murmur/blob/main/PRIVACY.md) for details.

**Which LLM providers are supported?**
Anthropic Claude, OpenAI, Google Gemini, and OpenRouter, using your own API key entered in the app.

**How do I install the daemon on my Pi?**
See the [daemon README](https://github.com/nekonihq/murmur/blob/main/daemon/README.md) for the
one-line install script and manual setup steps.

## Contact

For anything not covered above, email **denys@malykhin.dev** and we'll get back to you.
