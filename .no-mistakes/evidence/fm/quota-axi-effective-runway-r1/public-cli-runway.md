# Public CLI effective runway evidence

This transcript exercises the public `main()` CLI surface with a fixed report clock and read-only provider fixtures matching the required regression scenario. It shows that raw percentage alone does not stand in for usable time: Claude has 1% remaining near reset and 178 seconds of projected runway, while Codex has 55% remaining and 258,720 seconds of projected runway.

The compact TOON makes effective headroom and runway primary. Its window and effective tables contain no numeric reserve column. The help copy directs users to `--json` or `--full` for reserve diagnostics.

```text
bin: quota-axi
description: Report local agent-provider quota windows for routing-aware agents
generatedAt: "2026-07-15T12:00:00.000Z"
providers[2]{provider,plan,source,status,authStatus,refreshedAt}:
  claude,unknown,oauth,fresh,unknown,none
  codex,unknown,oauth,fresh,unknown,none
windows[2]{provider,id,label,percentRemaining,resetsAt,pace,state}:
  claude,five_hour,session,1,"2026-07-15T12:06:00.000Z",on_pace,fresh
  codex,weekly,week,55,"2026-07-20T01:12:00.000Z",ahead,fresh
effective[2]{provider,scope,effectivePercentRemaining,boundedBy,limitingWindowIds,runway,usableRunwaySeconds,projectedExhaustedAt,limitingWindowId,projectionConfidence,projectionBasis,unmeasurableWindowIds,unresolvedWindowIds,relationshipStatus}:
  claude,all_models,1,five_hour,five_hour,projected_exhaustion,178,"2026-07-15T12:02:58.181Z",five_hour,established,cycle_average,none,none,known
  codex,all_models,55,weekly,weekly,projected_exhaustion,258720,"2026-07-18T11:52:00.000Z",weekly,established,cycle_average,none,none,known
help[4]:
  Default TOON reports effective headroom and usable runway; use --json or --full for reserve diagnostics
  Run `quota-axi --provider claude --json` for JSON output
  Run `quota-axi --full` to include account, source-attempt, and reserve details
  Run `quota-axi auth` to inspect local auth source availability without printing secrets
```

Focused regression assertions additionally exercised `--full` and `--json`: full TOON contains `windowPace` reserve diagnostics, JSON retains `pace.reservePercentPoints`, and the compact transcript above contains neither numeric reserve table.
