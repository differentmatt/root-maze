import { useCallback, useEffect, useState } from 'react'
import {
  getMembers,
  removeMember,
  changeMemberRole,
  getInvites,
  createInvite,
  revokeInvite,
  inviteUrl,
  getGraph,
  linkPersonNode,
  unlinkPersonNode,
  ApiError,
  type Group,
  type Member,
  type Invite,
  type Role,
  type PersonNode,
} from '../api'
import PersonPicker from '../components/PersonPicker'
import { rankLinkCandidates } from '../components/personRanking'

type Status = 'loading' | 'ready' | 'error'

// Membership management for a single group: who's in it, their roles, and the
// shareable invite links. Any member can manage membership (the app is a casual
// shared family tree); the server still guarantees the group keeps ≥1 owner.
export default function MembersPanel({ group }: { group: Group }) {
  const groupId = group.groupId
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState('')
  const [members, setMembers] = useState<Member[]>([])
  const [me, setMe] = useState('')
  const [nodes, setNodes] = useState<PersonNode[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [busy, setBusy] = useState(false)
  // Which member's link is mid-flight, so only that row shows a spinner.
  const [linkBusyId, setLinkBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  // On a refresh (silent) we keep the panel on screen instead of flashing the
  // full "Loading…" state, so a link/role change feels in-place.
  const load = useCallback(async (silent = false) => {
    if (!silent) setStatus('loading')
    try {
      // The graph comes along so we can offer a "which person is this member?"
      // picker built from the group's people.
      const [m, i, g] = await Promise.all([
        getMembers(groupId),
        getInvites(groupId),
        getGraph(groupId),
      ])
      setMembers(m.members)
      setMe(m.me)
      setInvites(i.invites)
      setNodes(g.nodes)
      setStatus('ready')
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return
      setError(err instanceof Error ? err.message : 'Failed to load')
      setStatus('error')
    }
  }, [groupId])

  useEffect(() => {
    load()
  }, [load])

  // Run a mutation, surface any error, then silently reload the panel.
  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setNotice('')
    try {
      await fn()
      await load(true)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  // Like `run`, but scoped to one member's link so that row can show progress.
  async function runLink(accountId: string, fn: () => Promise<unknown>) {
    setLinkBusyId(accountId)
    setNotice('')
    try {
      await fn()
      await load(true)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setLinkBusyId(null)
    }
  }

  async function copyLink(token: string) {
    const url = inviteUrl(token)
    try {
      await navigator.clipboard.writeText(url)
      setNotice('Invite link copied')
    } catch {
      // Clipboard blocked (e.g. insecure context) — show the URL to copy by hand.
      setNotice(url)
    }
  }

  const isOwner = members.find((m) => m.accountId === me)?.role === 'owner'

  if (status === 'loading') return <p className="text-zinc-400">Loading members…</p>
  if (status === 'error') return <p className="text-red-400">Error: {error}</p>

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-zinc-300">Members</h2>
        <p className="text-xs text-zinc-500">
          Link each member to their person in the tree so everyone knows who’s
          who. You can also claim your own person from the tree with “This is
          me”.
        </p>
        <ul className="flex flex-col gap-2">
          {members.map((m) => (
            <li
              key={m.accountId}
              className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-zinc-100">
                    {m.name || m.email || m.accountId}
                    {m.accountId === me && (
                      <span className="ml-1 text-xs text-zinc-500">(you)</span>
                    )}
                  </p>
                  {m.email && m.name && (
                    <p className="truncate text-xs text-zinc-500">{m.email}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <select
                    aria-label={`Role for ${m.name || m.email || m.accountId}`}
                    value={m.role}
                    disabled={busy}
                    onChange={(e) =>
                      run(() => changeMemberRole(groupId, m.accountId, e.target.value as Role))
                    }
                    className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 focus:border-zinc-500 focus:outline-none disabled:opacity-40"
                  >
                    <option value="owner">owner</option>
                    <option value="editor">editor</option>
                  </select>
                  <button
                    onClick={() => run(() => removeMember(groupId, m.accountId))}
                    disabled={busy}
                    className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-red-400 hover:border-red-500/50 disabled:opacity-40"
                  >
                    {m.accountId === me ? 'Leave' : 'Remove'}
                  </button>
                </div>
              </div>
              <MemberLink
                member={m}
                nodes={nodes}
                canEdit={m.accountId === me || isOwner}
                busy={linkBusyId === m.accountId}
                disabled={busy || (linkBusyId !== null && linkBusyId !== m.accountId)}
                onLink={(nodeId) =>
                  runLink(m.accountId, () =>
                    linkPersonNode(groupId, m.accountId, nodeId),
                  )
                }
                onUnlink={() =>
                  runLink(m.accountId, () => unlinkPersonNode(groupId, m.accountId))
                }
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-300">Invite links</h2>
          <button
            onClick={() => run(() => createInvite(groupId))}
            disabled={busy}
            className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 disabled:opacity-40"
          >
            New invite link
          </button>
        </div>

        {invites.length === 0 && (
          <p className="text-xs text-zinc-500">
            No active invites. Create one and share the link with family.
          </p>
        )}

        <ul className="flex flex-col gap-2">
          {invites.map((inv) => (
            <li
              key={inv.token}
              className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2"
            >
              <div className="min-w-0 text-xs text-zinc-400">
                <p className="text-zinc-300">
                  Expires {new Date(inv.expiresAt).toLocaleDateString()}
                </p>
                <p className="text-zinc-500">
                  {inv.maxUses == null
                    ? `${inv.useCount} joined`
                    : `${inv.useCount}/${inv.maxUses} used`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => copyLink(inv.token)}
                  className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:border-zinc-500"
                >
                  Copy link
                </button>
                <button
                  onClick={() => run(() => revokeInvite(groupId, inv.token))}
                  disabled={busy}
                  className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-red-400 hover:border-red-500/50 disabled:opacity-40"
                >
                  Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {notice && (
        <p className="break-all text-xs text-zinc-400" role="status">
          {notice}
        </p>
      )}
    </div>
  )
}

// Which person in the tree a member is. Editable by the member themselves, or by
// an owner (matching the server-side rule); everyone else just sees the status.
// The picker offers unclaimed people plus the member's current person, so it
// can't accidentally steal someone else's link.
function MemberLink({
  member,
  nodes,
  canEdit,
  busy,
  disabled,
  onLink,
  onUnlink,
}: {
  member: Member
  nodes: PersonNode[]
  canEdit: boolean
  // `busy` = this member's link is mid-flight (show a spinner); `disabled` =
  // some other action is running, so lock the control without a spinner.
  busy: boolean
  disabled: boolean
  onLink: (nodeId: string) => void
  onUnlink: () => void
}) {
  if (!canEdit) {
    return (
      <p className="text-xs text-zinc-500">
        {member.linkedNodeName ? (
          <>
            Linked to <span className="text-zinc-300">{member.linkedNodeName}</span>
          </>
        ) : (
          'Not linked to a person'
        )}
      </p>
    )
  }

  const candidates = nodes.filter(
    (n) => !n.accountId || n.accountId === member.accountId,
  )
  // Float the people whose name/email look like this member to the top.
  const ranked = rankLinkCandidates(member, candidates)
  const options = [
    ...ranked.suggested.map((s) => ({
      id: s.node.nodeId,
      label: s.node.name,
      hint: s.hint,
      section: 'suggested' as const,
    })),
    ...ranked.rest.map((n) => ({
      id: n.nodeId,
      label: n.name,
      section: 'all' as const,
    })),
  ]

  return (
    <div className="flex items-center gap-2">
      <label className="shrink-0 text-xs text-zinc-500">Person</label>
      <div className="min-w-0 flex-1">
        <PersonPicker
          ariaLabel={`Linked person for ${member.name || member.email || member.accountId}`}
          options={options}
          value={member.linkedNodeId ?? null}
          disabled={busy || disabled}
          clearLabel="— not linked —"
          placeholder="Link a person…"
          onChange={(id) => (id ? onLink(id) : onUnlink())}
        />
      </div>
      {busy && <span className="shrink-0 text-xs text-zinc-500">Saving…</span>}
    </div>
  )
}
