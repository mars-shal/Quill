/**
 * What the account area should say, given what the backend reported.
 *
 * The backend's `AccountState` has two booleans, and one of them cannot carry
 * the message the UI wants. `online: false` means *either* sync is switched off
 * *or* the server did not answer -- and sign-in does not enable sync, so a reader
 * who signed in and declined to sync and a reader whose server is down are the
 * same two fields. Rendering that as one "Offline" badge next to a signed-in
 * name tells somebody their work is not syncing when it is not even trying, and
 * tells the other one their server is down when they never asked it to sync.
 *
 * So the truth is four states, not three and certainly not two, and this module
 * is where the distinction is drawn. It is pure so the mapping can be tested
 * without a server, a keyring, or a network.
 */

/** @typedef {'signed-out' | 'opted-out' | 'live' | 'unreachable'} AccountSituation */

const SIGNED_OUT = {
  situation: 'signed-out',
  label: 'Not signed in',
  detail: 'Local only',
  tone: 'idle',
  initials: '',
}

/**
 * Derives the situation and the strings for it.
 *
 * Order matters and is the whole point. `signedIn` is checked first because a
 * stale mirror with a dead server is still a signed-in reader with a local copy;
 * `syncEnabled` next, because "not syncing" is the *accurate* thing to say before
 * "the server is unreachable", which is a claim about a server that was asked
 * and did not answer.
 *
 * @param {{
 *   signedIn?: boolean,
 *   account?: {id: string, email: string, name: string, workspace: string} | null,
 *   online?: boolean,
 *   syncEnabled?: boolean,
 *   baseUrl?: string,
 * }} [state]
 */
export function describeAccount(state) {
  if (!state || !state.signedIn || !state.account) {
    return { ...SIGNED_OUT }
  }

  const { name, email, workspace } = state.account
  // Initials go on a 27px circle, so two letters -- from the name if there is
  // one, and from the local part of the email if there is not. Splitting an
  // address on `.` as well would give "sam@example.com" the initials "SE", which
  // reads as a name rather than as the fallback it is.
  const initials = name
    ? name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word[0].toUpperCase())
        .join('')
    : (email.split('@')[0] || '?')[0].toUpperCase()

  // `signedIn` is carried on the described object rather than left to each caller
  // to infer from `situation`. The components branch on it directly, and an
  // omitted field here meant the sheet rendered its signed-out form for a reader
  // who had just signed in -- while the chip beside it showed their address,
  // because the chip only read `label` and `email`. `account-state.test.mjs`
  // asserts it for every situation so the two cannot drift apart again.
  const base = {
    signedIn: true,
    name: name || '',
    email: email || '',
    workspace: workspace || 'Personal',
    initials,
    sync: null,
  }

  if (!state.syncEnabled) {
    return {
      ...base,
      situation: 'opted-out',
      label: name || email,
      detail: 'Sync off',
      tone: 'idle',
      // Distinct from `unreachable` on purpose. This is the state a naive
      // two-state badge gets wrong, so it is named and coloured separately
      // rather than folded into "offline".
      sync: { situation: 'opted-out', label: 'Sync is off', detail: 'Your notes stay on this device.' },
    }
  }

  if (state.online) {
    return {
      ...base,
      situation: 'live',
      label: name || email,
      detail: 'Syncing',
      tone: 'live',
      sync: { situation: 'live', label: 'Syncing', detail: state.baseUrl || '' },
    }
  }

  return {
    ...base,
    situation: 'unreachable',
    label: name || email,
    detail: 'Server unreachable',
    tone: 'warn',
    sync: {
      situation: 'unreachable',
      label: 'Sync server unreachable',
      detail: 'Changes are safe here and will go up when it is back.',
    },
  }
}

/**
 * The `sync_config_write` command overwrites both columns, so a caller flipping
 * the toggle has to send the endpoint it is trying to keep. Forgetting that is
 * not a data-loss bug in the database -- it is validated and stored -- it just
 * quietly points the reader's account at the build-time default, which is almost
 * certainly the wrong server and fails with a network error much later.
 *
 * This is the only place in the app that should construct that argument, so the
 * echo cannot be forgotten in one of two call sites.
 *
 * @param {string} baseUrl the currently configured endpoint
 * @param {boolean} syncEnabled
 */
export function configWriteArgs(baseUrl, syncEnabled) {
  return { baseUrl: baseUrl || '', syncEnabled: Boolean(syncEnabled) }
}
