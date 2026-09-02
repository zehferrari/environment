import { db } from "@/lib/db";
import { formatHours } from "@/lib/billing/rate";

export type BillingHistoryEntry = {
  id: string;
  project: { slug: string; name: string };
  fromDate: string;
  toDate: string;
  agentSlug: string;
  status: string;
  updatedAt: Date;
  totalHours: string;
  days: Array<{
    id: string;
    day: string;
    summary: string;
    rationale: string | null;
    minutes: number;
    excluded: boolean;
  }>;
};

export async function listBillingHistory(args: {
  projectIds: string[];
  requestedById: string;
  excludeReportIds?: string[];
  take?: number;
}): Promise<BillingHistoryEntry[]> {
  if (args.projectIds.length === 0) return [];
  const reports = await db.billingReport.findMany({
    where: {
      projectId: { in: args.projectIds },
      requestedById: args.requestedById,
      status: { in: ["ready", "final"] },
      days: { some: {} },
      ...(args.excludeReportIds?.length ? { id: { notIn: args.excludeReportIds } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: args.take ?? 50,
    select: {
      id: true,
      fromDate: true,
      toDate: true,
      agentSlug: true,
      status: true,
      updatedAt: true,
      project: { select: { slug: true, name: true } },
      days: {
        orderBy: { day: "asc" },
        select: {
          id: true,
          day: true,
          summary: true,
          rationale: true,
          estimatedMinutes: true,
          overrideMinutes: true,
          excluded: true,
        },
      },
    },
  });

  return reports.map((report) => {
    const days = report.days.map((day) => ({
      id: day.id,
      day: day.day,
      summary: day.summary,
      rationale: day.rationale,
      minutes: day.overrideMinutes ?? day.estimatedMinutes,
      excluded: day.excluded,
    }));
    const totalMinutes = days.reduce((sum, day) => sum + (day.excluded ? 0 : day.minutes), 0);
    return {
      id: report.id,
      project: report.project,
      fromDate: report.fromDate,
      toDate: report.toDate,
      agentSlug: report.agentSlug,
      status: report.status,
      updatedAt: report.updatedAt,
      totalHours: formatHours(totalMinutes),
      days,
    };
  });
}
