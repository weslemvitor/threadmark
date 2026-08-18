import type {
  DirectoryGroupDto,
  DirectoryPersonDto,
  DirectorySnapshotDto,
} from "../../shared/contracts.js";
import type { SupportDatabase } from "../db/index.js";

import { isHumanParticipantDisplayName } from "./participant-identity.js";

interface PersonRow {
  id: string;
  display_name: string;
  phone_e164: string | null;
  external_jid: string;
  is_staff: number;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

interface IdentityLinkRow {
  phone_jid: string;
  lid_jid: string;
}

interface CanonicalPersonGroup {
  canonicalJid: string;
  representative: PersonRow;
  aliases: PersonRow[];
}

function latestTimestamp(...values: Array<string | null>): string | null {
  const available = values.filter((value): value is string => Boolean(value));
  return available.length ? available.sort().at(-1)! : null;
}

function phoneFromJid(jid: string): string | null {
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  const digits = jid.slice(0, -"@s.whatsapp.net".length);
  return /^\d{7,15}$/.test(digits) ? `+${digits}` : null;
}

function normalizedPhone(value: string | null): string | null {
  const candidate = value?.trim() ?? "";
  return /^\+\d{7,15}$/.test(candidate) ? candidate : null;
}

function isHumanDisplayName(name: string, aliases: readonly PersonRow[]): boolean {
  return isHumanParticipantDisplayName(
    name,
    aliases.flatMap((alias) => [alias.external_jid, alias.phone_e164]),
  );
}

function canonicalPersonGroups(
  rows: readonly PersonRow[],
  links: readonly IdentityLinkRow[],
): CanonicalPersonGroup[] {
  const canonicalJidByAlias = new Map<string, string>();
  for (const link of links) {
    canonicalJidByAlias.set(link.phone_jid, link.phone_jid);
    canonicalJidByAlias.set(link.lid_jid, link.phone_jid);
  }

  const aliasesByCanonicalJid = new Map<string, PersonRow[]>();
  for (const row of rows) {
    const canonicalJid = canonicalJidByAlias.get(row.external_jid) ?? row.external_jid;
    aliasesByCanonicalJid.set(canonicalJid, [
      ...(aliasesByCanonicalJid.get(canonicalJid) ?? []),
      row,
    ]);
  }

  return [...aliasesByCanonicalJid].map(([canonicalJid, aliases]) => {
    const orderedAliases = aliases.toSorted((left, right) => {
      const leftIsCanonical = left.external_jid === canonicalJid ? 0 : 1;
      const rightIsCanonical = right.external_jid === canonicalJid ? 0 : 1;
      if (leftIsCanonical !== rightIsCanonical) return leftIsCanonical - rightIsCanonical;
      const leftIsPhone = left.external_jid.endsWith("@s.whatsapp.net") ? 0 : 1;
      const rightIsPhone = right.external_jid.endsWith("@s.whatsapp.net") ? 0 : 1;
      if (leftIsPhone !== rightIsPhone) return leftIsPhone - rightIsPhone;
      return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
    });
    return { canonicalJid, representative: orderedAliases[0]!, aliases };
  });
}

export class DirectoryStore {
  constructor(readonly database: SupportDatabase) {}

  getSnapshot(): DirectorySnapshotDto {
    const groups = this.readGroups();
    const people = this.readPeople();
    return {
      groups,
      people,
      totals: { groups: groups.length, people: people.length },
    };
  }

  private readGroups(): DirectoryGroupDto[] {
    const rows = this.database
      .prepare(
        `SELECT
           group_row.id,
           group_row.subject,
           group_row.external_jid,
           group_row.monitored,
           (SELECT COUNT(DISTINCT COALESCE(
              identity.phone_jid,
              NULLIF(participant.phone_e164, ''),
              participant.external_jid
            ))
            FROM group_participants membership
            JOIN participants participant ON participant.id = membership.participant_id
            LEFT JOIN whatsapp_identity_links identity
              ON identity.phone_jid = participant.external_jid
              OR identity.lid_jid = participant.external_jid
            WHERE membership.group_id = group_row.id AND membership.active = 1
           ) AS participant_count,
           (SELECT COUNT(*) FROM tickets ticket
            WHERE ticket.group_id = group_row.id) AS ticket_count,
           (SELECT COUNT(*) FROM tickets ticket
            WHERE ticket.group_id = group_row.id
              AND ticket.status NOT IN ('resolved', 'archived')) AS open_ticket_count,
           (SELECT MAX(message.occurred_at) FROM messages message
            WHERE message.group_id = group_row.id) AS last_activity_at
         FROM whatsapp_groups group_row
         WHERE group_row.external_jid LIKE '%@g.us'
         ORDER BY group_row.subject COLLATE NOCASE, group_row.id`,
      )
      .all() as Array<{
      id: string;
      subject: string;
      external_jid: string;
      monitored: number;
      participant_count: number;
      ticket_count: number;
      open_ticket_count: number;
      last_activity_at: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      externalJid: row.external_jid,
      monitored: Boolean(row.monitored),
      participantCount: row.participant_count,
      ticketCount: row.ticket_count,
      openTicketCount: row.open_ticket_count,
      lastActivityAt: row.last_activity_at,
    }));
  }

  private readPeople(): DirectoryPersonDto[] {
    const memberships = this.database
      .prepare(
        `SELECT membership.participant_id, membership.group_id
         FROM group_participants membership
         JOIN whatsapp_groups group_row ON group_row.id = membership.group_id
         WHERE membership.active = 1
           AND group_row.external_jid LIKE '%@g.us'`,
      )
      .all() as Array<{ participant_id: string; group_id: string }>;
    const activeGroupIdsByParticipant = new Map<string, Set<string>>();
    for (const membership of memberships) {
      const groups = activeGroupIdsByParticipant.get(membership.participant_id) ??
        new Set<string>();
      groups.add(membership.group_id);
      activeGroupIdsByParticipant.set(membership.participant_id, groups);
    }

    const people = canonicalPersonGroups(
      this.readPersonRows(),
      this.readIdentityLinks(),
    ).flatMap((group) => {
      const activeGroupIds = new Set(
        group.aliases.flatMap((alias) => [
          ...(activeGroupIdsByParticipant.get(alias.id) ?? []),
        ]),
      );
      const lastActivityAt = latestTimestamp(
        ...group.aliases.map((alias) => alias.last_activity_at),
      );
      if (activeGroupIds.size === 0 && !lastActivityAt) return [];

      const humanName = group.aliases
        .filter((alias) => isHumanDisplayName(alias.display_name, group.aliases))
        .toSorted(
          (left, right) =>
            right.updated_at.localeCompare(left.updated_at) ||
            Number(right.id === group.representative.id) -
              Number(left.id === group.representative.id) ||
            left.id.localeCompare(right.id),
        )[0]?.display_name.trim();
      const phoneE164 =
        phoneFromJid(group.canonicalJid) ??
        group.aliases
          .map((alias) => normalizedPhone(alias.phone_e164))
          .find((phone): phone is string => Boolean(phone)) ??
        null;
      if (!humanName && !phoneE164) return [];

      return [{
        id: group.representative.id,
        displayName: humanName ?? phoneE164 ?? group.canonicalJid,
        phoneE164,
        externalJid: group.canonicalJid,
        isStaff: group.aliases.some((alias) => Boolean(alias.is_staff)),
        activeGroupCount: activeGroupIds.size,
        lastActivityAt,
      } satisfies DirectoryPersonDto];
    });

    people.sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName, "pt-BR", {
          sensitivity: "base",
        }) || left.id.localeCompare(right.id),
    );
    return people;
  }

  private readPersonRows(): PersonRow[] {
    return this.database
      .prepare(
        `SELECT
           participant.id,
           participant.display_name,
           participant.phone_e164,
           participant.external_jid,
           participant.created_at,
           participant.updated_at,
           EXISTS (
             SELECT 1 FROM staff_members staff
             WHERE staff.participant_id = participant.id AND staff.active = 1
           ) AS is_staff,
           activity.last_activity_at
         FROM participants participant
         LEFT JOIN (
           SELECT sender_id, MAX(occurred_at) AS last_activity_at
           FROM messages
           GROUP BY sender_id
         ) activity ON activity.sender_id = participant.id`,
      )
      .all() as PersonRow[];
  }

  private readIdentityLinks(): IdentityLinkRow[] {
    return this.database
      .prepare(
        `SELECT phone_jid, lid_jid
         FROM whatsapp_identity_links
         ORDER BY phone_jid, lid_jid`,
      )
      .all() as IdentityLinkRow[];
  }
}
