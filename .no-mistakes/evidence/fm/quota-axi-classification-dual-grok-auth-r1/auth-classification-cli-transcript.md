# Authentication classification end-to-end evidence

These reports came from the real `quota-axi` CLI entry point with isolated
Grok and Pi credential directories. All credential values were synthetic.
The no-window reports intentionally exit with status 1 while still rendering
their normalized provider state.

## Valid Pi xAI API key, no Grok CLI session

Command:

```sh
env -u GROK_AUTH_JSON -u GROK_AUTH -u GROK_AUTH_PATH \
  GROK_HOME="$PWD/.no-mistakes/test-runtime/grok-empty" \
  PI_CODING_AGENT_DIR="$PWD/.no-mistakes/test-runtime/pi-valid" \
  XDG_CACHE_HOME="$PWD/.no-mistakes/test-runtime/cache-valid" \
  pnpm dev -- --provider grok --json
```

Rendered provider:

```json
{
  "provider": "grok",
  "label": "Grok",
  "source": "unavailable",
  "windows": [],
  "state": {
    "status": "unavailable",
    "stale": false,
    "error": "Grok consumer quota unavailable",
    "sourcesTried": ["auth-json", "pi:xai"],
    "authStatus": "usable"
  }
}
```

This proves Pi-only model usability does not invent consumer windows and is
not classified as logout.

## Expired-refreshable Pi xAI OAuth, no Grok CLI session

Command:

```sh
env -u GROK_AUTH_JSON -u GROK_AUTH -u GROK_AUTH_PATH \
  GROK_HOME="$PWD/.no-mistakes/test-runtime/grok-empty" \
  PI_CODING_AGENT_DIR="$PWD/.no-mistakes/test-runtime/pi-expired" \
  XDG_CACHE_HOME="$PWD/.no-mistakes/test-runtime/cache-expired" \
  pnpm dev -- --provider grok
```

Compact TOON:

```text
providers[1]{provider,plan,source,status,authStatus,refreshedAt}:
  grok,unknown,unavailable,unavailable,expired_refreshable,none
```

This proves default compact output machine-readably distinguishes soft expiry
from `auth_required` sign-out.

## Neither independent source available

Command:

```sh
env -u GROK_AUTH_JSON -u GROK_AUTH -u GROK_AUTH_PATH \
  GROK_HOME="$PWD/.no-mistakes/test-runtime/grok-empty" \
  PI_CODING_AGENT_DIR="$PWD/.no-mistakes/test-runtime/pi-missing" \
  XDG_CACHE_HOME="$PWD/.no-mistakes/test-runtime/cache-missing" \
  pnpm dev -- --provider grok --json
```

Rendered state:

```json
{
  "status": "auth_required",
  "stale": false,
  "error": "Grok sign-in required",
  "sourcesTried": ["auth-json", "pi:xai"],
  "authStatus": "unusable"
}
```

This proves true sign-out is reserved for the case where neither source is
usable.

## Read-only auth inspection and non-disclosure

`quota-axi auth --provider grok --json` reported both sources without emitting
the synthetic API key:

```json
{
  "provider": "grok",
  "sources": [
    {
      "source": "auth-json",
      "status": "missing"
    },
    {
      "source": "pi:xai",
      "status": "available"
    }
  ]
}
```

SHA-256 values before and after the auth inspection were identical:

```text
before  5670155c4584079b19f67992dd2b72ddb1f58b71df4c7eae8698b7dbc4c91649  pi-valid/auth.json
after   5670155c4584079b19f67992dd2b72ddb1f58b71df4c7eae8698b7dbc4c91649  pi-valid/auth.json
before  f9be4fb2a9729e7ce4d08a08b499cc766a178eb6f941073178146e3584df855d  pi-expired/auth.json
after   f9be4fb2a9729e7ce4d08a08b499cc766a178eb6f941073178146e3584df855d  pi-expired/auth.json
```

The focused automated tests additionally assert that Codex identity metadata
and Pi access, refresh, and API-key fixtures never appear in normalized output.
