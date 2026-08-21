#!/usr/bin/env bash
#
# Decides whether a pull request satisfies the "PR must be raised via no-mistakes"
# required check.
#
# A PR passes when any of these hold:
#   * its body carries the no-mistakes pipeline signature AND a pipeline
#     attestation recording review, test, and document as completed, or
#   * it was opened by dependabot[bot], or
#   * it is structurally a release-please release PR (see below).
#
# The signature alone only proves the pipeline wrote the body; the attestation
# (no-mistakes >= 1.46.0) proves which steps actually ran, and its head_sha must
# name the PR's current head so a commit pushed after the run cannot ride on a
# stale attestation. All of that is required of a pipeline-raised PR. The
# exemptions below need none of it.
#
# The release-please exemption is deliberately STRUCTURAL, never author identity.
# release-please opens quota-axi's release PRs as github-actions[bot] today, but
# exempting that login would exempt every other workflow-opened PR too, and would
# break the moment release-please is switched to a PAT and starts arriving as the
# human `kunchenguid`, who also opens ordinary human PRs.
#
# Every exemption lives here rather than in a job-level `if:` so the whole gate
# has one executable surface that tests can drive directly, and so the release
# workflow's status-stamping job can reuse the very same decision.
#
# Inputs (environment):
#   PR_BODY, PR_AUTHOR, PR_NUMBER, PR_HEAD_REF, PR_HEAD_REPO, PR_BASE_REPO,
#   PR_HEAD_SHA
# External tools: jq (attestation parsing only; the exemption paths never use it).
# Exit status: 0 = pass, 1 = fail.
set -eu

NO_MISTAKES_MARKER='Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)'
RELEASE_PLEASE_MARKER='This PR was generated with [Release Please]'
RELEASE_PLEASE_BRANCH_PREFIX='release-please--'
RELEASE_PLEASE_LEGACY_BRANCH_PREFIX='release-please/'
ATTESTATION_PREFIX='<!-- no-mistakes-pipeline-attestation:v1 '
ATTESTATION_SUFFIX=' -->'

pr_body="${PR_BODY:-}"
pr_author="${PR_AUTHOR:-unknown}"
pr_number="${PR_NUMBER:-unknown}"
pr_head_ref="${PR_HEAD_REF:-}"
pr_head_repo="${PR_HEAD_REPO:-}"
pr_base_repo="${PR_BASE_REPO:-}"
pr_head_sha="${PR_HEAD_SHA:-}"

body_contains() {
    printf '%s' "$pr_body" | grep -qF -- "$1"
}

is_exempt_bot() {
    case "$pr_author" in
        'dependabot[bot]') return 0 ;;
        *) return 1 ;;
    esac
}

# Condition 1: a branch under release-please's reserved branch prefix. quota-axi's
# release branch carries a component suffix
# (`release-please--branches--main--components--quota-axi`), which the prefix test
# covers. The legacy `release-please/` prefix is accepted for older setups.
is_release_please_branch() {
    case "$pr_head_ref" in
        "$RELEASE_PLEASE_BRANCH_PREFIX"* | "$RELEASE_PLEASE_LEGACY_BRANCH_PREFIX"*) return 0 ;;
        *) return 1 ;;
    esac
}

# Condition 2: same-repo head. A fork can copy the branch name and the body but
# cannot make its head repository be this repository.
is_same_repo_head() {
    [ -n "$pr_head_repo" ] && [ -n "$pr_base_repo" ] && [ "$pr_head_repo" = "$pr_base_repo" ]
}

# Condition 3: release-please's generated body footer.
has_release_please_footer() {
    body_contains "$RELEASE_PLEASE_MARKER"
}

# The signature alone only proves the pipeline wrote the body. no-mistakes
# >= 1.46.0 also emits a machine-readable step attestation next to it; parse
# that to prove review, test, and document actually ran to completion.
# Contract: docs/reference/pipeline-steps.md#pipeline-step-attestation in
# kunchenguid/no-mistakes.
verify_attestation() {
    if ! body_contains "$ATTESTATION_PREFIX"; then
        echo "::error::This PR carries the no-mistakes signature but no pipeline attestation."
        {
            echo
            echo "no-mistakes >= 1.46.0 is required (PR 670). That release writes a"
            echo "machine-readable comment next to the signature:"
            echo
            echo "    ${ATTESTATION_PREFIX}{\"head_sha\":\"...\",\"steps\":[...]}${ATTESTATION_SUFFIX}"
            echo
            echo "Upgrade no-mistakes ('no-mistakes update'), then re-run"
            echo "'git push no-mistakes' so the PR body is rewritten with the attestation."
            echo
            echo "PR author: ${pr_author}"
        } >&2
        return 1
    fi

    # Exact-substring extraction (no regex): first prefix, then the first
    # closing token after it, mirroring how no-mistakes' own consumer test
    # slices the payload.
    payload="$(
        printf '%s' "$pr_body" | tr -d '\r' | awk -v pre="$ATTESTATION_PREFIX" -v suf="$ATTESTATION_SUFFIX" '
          found { next }
          {
            p = index($0, pre)
            if (p == 0) next
            rest = substr($0, p + length(pre))
            s = index(rest, suf)
            if (s == 0) next
            print substr(rest, 1, s - 1)
            found = 1
          }
        '
    )"

    if [ -z "$payload" ]; then
        echo "::error::The no-mistakes pipeline attestation comment is malformed: no JSON payload could be extracted."
        {
            echo
            echo "The '${ATTESTATION_PREFIX}' marker is present but is not closed by"
            echo "'${ATTESTATION_SUFFIX}' on the same line, or the payload is empty."
            echo "This gate fails closed on an unreadable attestation."
            echo
            echo "PR author: ${pr_author}"
        } >&2
        return 1
    fi

    # Real JSON parsing. Emits one "<step>\t<verdict>\t<detail>" line per
    # required step. A step recorded more than once must be completed in
    # every record. Any skip-shaped sibling key (a future 'skipped',
    # 'skip_reason', 'quota_...', '..._unavailable' field) with a meaningful
    # value is rejected outright, so a skip can never ride along on a
    # 'completed' status.
    if ! report="$(
        printf '%s' "$payload" | jq -r --argjson required '["review","test","document"]' '
          if type != "object" then error("attestation payload is not a JSON object") else . end
          | if (.steps | type) != "array" then error("attestation payload has no \"steps\" array") else . end
          | . as $attestation
          | $required[]
          | . as $name
          | [ $attestation.steps[] | select((type == "object") and ((.step? | tostring) == $name)) ] as $records
          | if ($records | length) == 0 then
              "\($name)\tmissing\tno record in attestation"
            else
              ([ $records[] | (.status? // null) | tostring ] | unique) as $statuses
              | ([ $records[]
                   | to_entries[]
                   | select((.key | ascii_downcase) | test("skip|quota|unavailable"))
                   | select(.value != null and .value != false and .value != "")
                   | .key ] | unique) as $skip_markers
              | if ($skip_markers | length) > 0 then
                  "\($name)\tskip-marker\t\($skip_markers | join(","))"
                elif $statuses == ["completed"] then
                  "\($name)\tok\tcompleted"
                else
                  "\($name)\tbad\t\($statuses | join(","))"
                end
            end
        ' 2>&1
    )"; then
        echo "::error::The no-mistakes pipeline attestation payload could not be parsed as JSON."
        {
            echo
            echo "jq reported:"
            echo "$report"
            echo
            echo "Payload: $payload"
            echo
            echo "This gate fails closed on an unparseable attestation."
            echo
            echo "PR author: ${pr_author}"
        } >&2
        return 1
    fi

    attested_head="$(printf '%s' "$payload" | jq -r '.head_sha // ""')"
    echo "Attestation head_sha: ${attested_head:-(absent)}"

    # Head binding. The attestation describes the commit no-mistakes ran its
    # steps on; a later push moves the PR head without rewriting the body, so an
    # attestation that does not name the current head proves nothing about the
    # code being merged. A `synchronize` whose body was NOT rewritten by
    # no-mistakes going red is the intended contract, not a false positive.
    if [ -z "$attested_head" ] || [ -z "$pr_head_sha" ] || [ "$attested_head" != "$pr_head_sha" ]; then
        echo "::error::The no-mistakes pipeline attestation is STALE for the current head of PR #${pr_number}."
        {
            echo
            echo "Attestation head_sha: ${attested_head:-(absent)}"
            echo "PR head sha:          ${pr_head_sha:-(absent)}"
            echo
            echo "A commit was pushed after the no-mistakes run, so the attestation does not"
            echo "describe the code this PR now proposes to merge."
            echo
            echo "Re-run 'git push no-mistakes' to refresh it."
            echo
            echo "PR author: ${pr_author}"
        } >&2
        return 1
    fi

    tab="$(printf '\t')"
    gate_status=0
    checked=0
    while IFS="$tab" read -r name verdict detail; do
        [ -n "$name" ] || continue
        checked=$((checked + 1))
        case "$verdict" in
            ok)
                echo "  ok: ${name} = completed"
                ;;
            missing)
                echo "::error::The no-mistakes pipeline attestation has no '${name}' step record; '${name}' must be recorded as completed."
                gate_status=1
                ;;
            skip-marker)
                echo "::error::The no-mistakes pipeline attestation marks '${name}' with skip indicator(s) [${detail}]; quota-exhaustion and agent-unavailability skips are not accepted."
                gate_status=1
                ;;
            *)
                echo "::error::The no-mistakes pipeline attestation records '${name}' as '${detail}', not 'completed'."
                gate_status=1
                ;;
        esac
    done <<REPORT
$report
REPORT

    # A verdict per required step is the only shape jq can emit for a payload
    # it accepted. Assert it anyway so an unexpected empty report fails closed
    # instead of reporting nothing and passing.
    if [ "$checked" -ne 3 ]; then
        echo "::error::The no-mistakes attestation gate reached a verdict for ${checked} of the 3 required steps (review, test, document); failing closed."
        gate_status=1
    fi

    if [ "$gate_status" -ne 0 ]; then
        {
            echo
            echo "The no-mistakes review, test, and document steps must all be recorded as"
            echo "'completed'. A step that was skipped (pre-skipped with --skip, skipped at a"
            echo "gate, or skipped because the agent was unavailable or out of quota), failed,"
            echo "or never finished is not accepted."
            echo
            echo "Re-run 'git push no-mistakes' and let review, test, and document run."
            echo
            echo "Attestation payload: $payload"
            echo
            echo "PR author: ${pr_author}"
        } >&2
        return 1
    fi

    echo "no-mistakes pipeline attestation verified for PR #${pr_number}: review, test, and document all completed."
}

if body_contains "$NO_MISTAKES_MARKER"; then
    echo "Found no-mistakes signature in PR #${pr_number} body."
    verify_attestation || exit 1
    exit 0
fi

if is_exempt_bot; then
    echo "PR #${pr_number} was opened by ${pr_author}; exempt from the no-mistakes signature."
    exit 0
fi

if is_release_please_branch && is_same_repo_head && has_release_please_footer; then
    echo "PR #${pr_number} is a release-please release PR (same-repo branch '${pr_head_ref}' with the Release Please footer); exempt from the no-mistakes signature."
    exit 0
fi

{
    echo "::error::This PR was not raised through no-mistakes."
    echo
    echo "Contributions to this repository must be submitted via 'git push no-mistakes'."
    echo "That pipeline runs the required review/test/lint/CI steps and writes a"
    echo "deterministic '## Pipeline' section into the PR body containing:"
    echo
    echo "    $NO_MISTAKES_MARKER"
    echo
    echo "The only other way to pass is release-please's own release PR, which must"
    echo "satisfy all three structural conditions: a '${RELEASE_PLEASE_BRANCH_PREFIX}'"
    echo "(or legacy '${RELEASE_PLEASE_LEGACY_BRANCH_PREFIX}') head branch, a"
    echo "same-repository (non-fork) head, and the Release Please body footer."
    echo
    echo "PR author: ${pr_author}"
    echo "Head branch: ${pr_head_ref:-unknown}"
    echo "Head repository: ${pr_head_repo:-unknown} (base ${pr_base_repo:-unknown})"
} >&2
exit 1
