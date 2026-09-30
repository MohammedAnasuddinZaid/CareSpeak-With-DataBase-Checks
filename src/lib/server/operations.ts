import type { RowDataPacket } from "mysql2/promise";
import { query } from "./db";
import type { AuthUser } from "./auth";
import {
  ResponseSlice,
  RoundingBoard,
  inactivityWatch,
  marAdherence,
  MarBoard,
  RepositioningWatch,
  slaSummary,
  StaffSla,
  taskCompliance,
  SLA_TARGET_MS,
  TaskRow,
  MarRow,
  OpenAlertRow,
} from "@/lib/operations";

/**
 * Ward operations command — the closed-loop accountability view.
 *
 * Everything here is read-only and staff-gated (`requireStaff` upstream). It
 * answers questions the ward board cannot: who acknowledged what in time,
 * whether today's repositioning/rounds tasks are getting done, whether doses
 * are being given, and whether inactivity/fall alerts are sitting too long.
 *
 * ABAC mirrors the ward board: admins see the whole ward; a nurse sees only
 * beds of patients they are actively assigned to, plus unbound beds. On the
 * response scoreboard a nurse additionally only ever sees their own row; only
 * admins see the full comparison.
 */

export interface WardOperations {
  scope: "ward";
  serverTime: number;
  selfOnly: boolean;
  slaTargetMs: number;
  scoreboard: StaffSla[];
  rounding: RoundingBoard;
  mar: MarBoard;
  repositioning: RepositioningWatch;
}

interface ScoreRow extends RowDataPacket {
  ack_by: number | null;
  staff_name: string | null;
  ack_ms: number | null;
  escalated: number;
  resolved: number;
}

interface TaskSqlRow extends RowDataPacket, Omit<TaskRow, "dueMs" | "completedMs" | "id"> {
  id: number;
  kind: string;
  status: string;
  title: string | null;
  bed_code: string | null;
  patient: string | null;
  due_ms: number | null;
  completed_ms: number | null;
  completed_by: string | null;
}

interface MarSqlRow extends RowDataPacket, Omit<MarRow, "scheduledMs" | "administeredMs"> {
  medication: string;
  dose: string | null;
  status: string;
  scheduled_ms: number | null;
  administered_ms: number | null;
}

interface AlertSqlRow extends RowDataPacket, Omit<OpenAlertRow, "raisedMs"> {
  raised_ms: number | null;
}

/** Bed-scope clause matching the ward board. Admin: all. Nurse: assigned + unbound. */
function scopeSql(user: AuthUser, alias: string): [string, unknown[]] {
  if (user.role === "admin") return ["", []];
  return [
    `AND (${alias}.patient_id IS NULL OR EXISTS (
            SELECT 1 FROM care_assignments ca
             WHERE ca.staff_id = ? AND ca.patient_id = ${alias}.patient_id
               AND ca.unassigned_at IS NULL))`,
    [Number(user.id)],
  ];
}

const SCORE_SQL = `
  SELECT a.ack_by,
         u.display_name AS staff_name,
         TIMESTAMPDIFF(MICROSECOND, a.raised_at, a.ack_at) / 1000 AS ack_ms,
         (a.escalated_at IS NOT NULL) AS escalated,
         (a.resolved_at IS NOT NULL) AS resolved
    FROM alerts a
    LEFT JOIN users u ON u.id = a.ack_by
   WHERE a.raised_at >= NOW() - INTERVAL 7 DAY
     AND a.ack_by IS NOT NULL
     AND a.ack_at IS NOT NULL`;

const TASKS_SQL = `
  SELECT ct.id, ct.kind, ct.status, ct.title,
         b.bed_code,
         p.display_name AS patient,
         UNIX_TIMESTAMP(ct.due_at) * 1000 AS due_ms,
         UNIX_TIMESTAMP(ct.completed_at) * 1000 AS completed_ms,
         cu.display_name AS completed_by
    FROM care_tasks ct
    LEFT JOIN beds b   ON b.id = ct.bed_id
    LEFT JOIN users p  ON p.id = ct.patient_id
    LEFT JOIN users cu ON cu.id = ct.completed_by
   WHERE (ct.due_at >= CURDATE() OR ct.created_at >= CURDATE())
      OR ct.status IN ('pending', 'in_progress')`;

const MAR_SQL = `
  SELECT b.bed_code,
         p.display_name AS patient,
         ma.medication, ma.dose, ma.status,
         UNIX_TIMESTAMP(ma.scheduled_at)    * 1000 AS scheduled_ms,
         UNIX_TIMESTAMP(ma.administered_at) * 1000 AS administered_ms
    FROM medication_admin ma
    LEFT JOIN beds b   ON b.id = ma.bed_id
    LEFT JOIN users p  ON p.id = ma.patient_id
   WHERE ma.scheduled_at >= CURDATE()
     AND ma.scheduled_at < CURDATE() + INTERVAL 1 DAY`;

const WATCH_SQL = `
  SELECT a.id, a.kind, a.severity, a.title,
         s.session_code AS session,
         b.bed_code,
         p.display_name AS patient,
         UNIX_TIMESTAMP(a.raised_at) * 1000 AS raised_ms
    FROM alerts a
    LEFT JOIN console_sessions s ON s.id = a.session_id
    LEFT JOIN beds b   ON b.id = a.bed_id
    LEFT JOIN users p  ON p.id = a.patient_id
   WHERE a.status = 'open'
     AND a.kind IN ('inactivity', 'fall', 'bed_exit', 'wandering')
     AND s.status = 'active' AND s.expires_at > NOW(3)`;

export async function wardOperations(user: AuthUser): Promise<WardOperations> {
  const now = Date.now();

  const [scoreSql, scoreParams] = scopeSql(user, "a");
  const [tasksSql, tasksParams] = scopeSql(user, "ct");
  const [marSql, marParams] = scopeSql(user, "ma");
  const [watchSql, watchParams] = scopeSql(user, "a");

  const [scoreRows, taskRows, marRows, alertRows] = await Promise.all([
    query<ScoreRow>(SCORE_SQL + scoreSql, scoreParams),
    query<TaskSqlRow>(TASKS_SQL + tasksSql, tasksParams),
    query<MarSqlRow>(MAR_SQL + marSql, marParams),
    query<AlertSqlRow>(WATCH_SQL + watchSql, watchParams),
  ]);

  const isAdmin = user.role === "admin";
  const ownId = Number(user.id);

  const slices: ResponseSlice[] = scoreRows
    .filter((r) => r.ack_by !== null && (isAdmin || Number(r.ack_by) === ownId))
    .map((r) => ({
      staffId: Number(r.ack_by),
      name: r.staff_name ?? `Staff #${r.ack_by}`,
      latencyMs: r.ack_ms === null ? NaN : Number(r.ack_ms),
      escalated: Number(r.escalated) === 1,
      resolved: Number(r.resolved) === 1,
    }));

  const tasks: TaskRow[] = taskRows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    status: r.status,
    title: r.title,
    bedCode: r.bed_code,
    patient: r.patient,
    dueMs: r.due_ms === null ? null : Number(r.due_ms),
    completedMs: r.completed_ms === null ? null : Number(r.completed_ms),
    completedBy: r.completed_by,
  }));

  const mar: MarRow[] = marRows.map((r) => ({
    bedCode: r.bed_code,
    patient: r.patient,
    medication: r.medication,
    dose: r.dose,
    status: r.status,
    scheduledMs: r.scheduled_ms === null ? null : Number(r.scheduled_ms),
    administeredMs: r.administered_ms === null ? null : Number(r.administered_ms),
  }));

  const open: OpenAlertRow[] = alertRows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    severity: r.severity,
    title: r.title,
    session: r.session,
    bedCode: r.bed_code,
    patient: r.patient,
    raisedMs: r.raised_ms === null ? NaN : Number(r.raised_ms),
  }));

  return {
    scope: "ward",
    serverTime: now,
    selfOnly: !isAdmin,
    slaTargetMs: SLA_TARGET_MS,
    scoreboard: slaSummary(slices),
    rounding: taskCompliance(tasks, now),
    mar: marAdherence(mar),
    repositioning: inactivityWatch(open, now),
  };
}