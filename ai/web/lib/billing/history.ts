import { db } from "@/lib/db";
import { formatHours, priceDayCents } from "@/lib/billing/rate";

export type BillingHistoryEntry = {
  id: string;
  project: { slug: string; name: string };
  fromDate: string;
  toDate: string;
  agentSlug: string;
  status: string;
  updatedAt: Date;
  overview: string;
  totalHours: string;
  totalAmountCents: number | null;
  currency: string | null;
  days: Array<{
    id: string;
    day: string;
    summary: string;
    rationale: string | null;
    minutes: number;
    excluded: boolean;
    amountCents: number | null;
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
      notes: true,
      rateCents: true,
      currency: true,
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
    const days = report.days.map((day) => {
      const minutes = day.overrideMinutes ?? day.estimatedMinutes;
      return {
        id: day.id,
        day: day.day,
        summary: day.summary,
        rationale: day.rationale,
        minutes,
        excluded: day.excluded,
        amountCents: !day.excluded && report.rateCents
          ? priceDayCents(minutes, report.rateCents)
          : null,
      };
    });
    const totalMinutes = days.reduce((sum, day) => sum + (day.excluded ? 0 : day.minutes), 0);
    const totalAmountCents = report.rateCents
      ? days.reduce((sum, day) => sum + (day.amountCents ?? 0), 0)
      : null;
    return {
      id: report.id,
      project: report.project,
      fromDate: report.fromDate,
      toDate: report.toDate,
      agentSlug: report.agentSlug,
      status: report.status,
      updatedAt: report.updatedAt,
      overview: report.notes?.trim() || days.slice(0, 2).map((day) => day.summary).join(" "),
      totalHours: formatHours(totalMinutes),
      totalAmountCents,
      currency: report.currency,
      days,
    };
  });
}
