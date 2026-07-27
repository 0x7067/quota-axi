# Claude authentication and stale-cache CLI evidence

This transcript was produced through the real `quota-axi --provider claude --json --full`
command path with an isolated Claude profile and cache. The fixture access token was
locally marked expired. Only `globalThis.fetch` was replaced so the two read-only usage
endpoint outcomes could be reproduced without contacting Anthropic.

## Definitive usage HTTP 401

The advisory-expired token is still tried. HTTP 401 returns an authentication failure,
exposes no stale windows, and retires the existing Claude cache.

```json
{
  "provider": {
    "provider": "claude",
    "label": "Claude",
    "source": "unavailable",
    "windows": [],
    "state": {
      "status": "auth_required",
      "stale": false,
      "error": "Claude sign-in required",
      "sourcesTried": ["keychain", "oauth"]
    },
    "attempts": [
      {
        "source": "keychain",
        "status": "skipped",
        "error": "credentials_missing"
      },
      {
        "source": "oauth",
        "status": "failed",
        "error": "Claude sign-in required"
      }
    ],
    "quotaSemantics": {
      "status": "unknown",
      "description": "No quota windows are available, so no effective remaining percentage can be computed.",
      "effectiveAvailability": []
    }
  },
  "cacheRetired": true
}
```

## Transient network failure

The same advisory-expired token is tried. A transient network failure can use the
eligible bounded cache window, but its raw percentage remains diagnostic and effective
availability is unknown.

```json
{
  "provider": "claude",
  "label": "Claude",
  "source": "cache",
  "windows": [
    {
      "id": "five_hour",
      "label": "session",
      "kind": "session",
      "percentUsed": 34,
      "percentRemaining": 66,
      "resetsAt": "2026-07-27T22:47:06.426Z"
    }
  ],
  "state": {
    "status": "stale",
    "stale": true,
    "refreshedAt": "2026-07-27T20:47:06.427Z",
    "error": "fixture network unavailable",
    "sourcesTried": ["keychain", "oauth", "cache"]
  },
  "attempts": [
    {
      "source": "keychain",
      "status": "skipped",
      "error": "credentials_missing"
    },
    {
      "source": "oauth",
      "status": "failed",
      "error": "fixture network unavailable"
    }
  ],
  "quotaSemantics": {
    "status": "unknown",
    "description": "The raw quota windows are stale diagnostic data, so effective remaining is unknown until the provider refreshes successfully.",
    "effectiveAvailability": [
      {
        "scope": "all_models",
        "status": "unknown",
        "boundedBy": ["five_hour"]
      }
    ]
  }
}
```
