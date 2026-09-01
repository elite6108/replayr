import type { AnalyticsReportRow } from "./analyticsReport";
import type { ReportInsight, ReportKpi, ReportRecommendation } from "./analyticsReportInsights";

function esc(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[^\x20-\x7E]/g, "?");
}

class PdfDoc {
  private pages: string[] = [];
  private current: string[] = [];
  private page = 1;
  y = 720;
  readonly width = 612;
  readonly height = 792;

  constructor(private footer: string) {
    this.beginPage();
  }

  beginPage() {
    if (this.current.length) this.pages.push(this.current.join("\n"));
    this.current = [];
    this.y = 720;
    this.page += this.pages.length ? 1 : 0;
    this.color(0.12, 0.14, 0.16);
    this.text(48, 760, "REPLAYR", { size: 11, bold: true });
    this.color(0.25, 0.72, 0.86);
    this.rect(48, 748, 516, 1.5);
    this.color(0.12, 0.14, 0.16);
  }

  ensure(space = 48) {
    if (this.y < 72 + space) {
      this.finishPage();
      this.beginPage();
    }
  }

  finishPage() {
    this.color(0.45, 0.48, 0.5);
    this.text(48, 40, this.footer, { size: 8 });
    this.text(520, 40, `Page ${this.pages.length + 1}`, { size: 8 });
  }

  color(r: number, g: number, b: number) {
    this.current.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
    this.current.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
  }

  text(x: number, y: number, value: string, opts: { size?: number; bold?: boolean } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? "F2" : "F1";
    this.current.push("BT");
    this.current.push(`/${font} ${size} Tf`);
    this.current.push(`${x.toFixed(1)} ${y.toFixed(1)} Td`);
    this.current.push(`(${esc(value)}) Tj`);
    this.current.push("ET");
  }

  heading(title: string) {
    this.ensure(36);
    this.y -= 22;
    this.color(0.12, 0.14, 0.16);
    this.text(48, this.y, title, { size: 14, bold: true });
    this.y -= 8;
    this.color(0.25, 0.72, 0.86);
    this.rect(48, this.y, 80, 1);
    this.y -= 16;
    this.color(0.12, 0.14, 0.16);
  }

  para(value: string) {
    const words = value.split(/\s+/);
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > 92) {
        this.ensure(16);
        this.text(48, this.y, line);
        this.y -= 13;
        line = word;
      } else line = next;
    }
    if (line) {
      this.ensure(16);
      this.text(48, this.y, line);
      this.y -= 16;
    }
  }

  bullet(value: string) {
    this.ensure(16);
    this.text(56, this.y, `• ${value}`);
    this.y -= 14;
  }

  rect(x: number, y: number, w: number, h: number) {
    this.current.push(`${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`);
  }

  table(headers: string[], rows: string[][]) {
    this.ensure(24 + rows.length * 14);
    const cols = headers.length;
    const width = 516 / cols;
    this.color(0.93, 0.95, 0.96);
    this.rect(48, this.y - 4, 516, 16);
    this.color(0.12, 0.14, 0.16);
    headers.forEach((header, index) => this.text(52 + index * width, this.y, header.slice(0, 22), { size: 8, bold: true }));
    this.y -= 16;
    for (const row of rows) {
      this.ensure(16);
      row.forEach((cell, index) => this.text(52 + index * width, this.y, String(cell).slice(0, 24), { size: 8 }));
      this.y -= 13;
    }
    this.y -= 8;
  }

  sparkline(labels: string[], values: Array<number | null>) {
    const points = values
      .map((value, index) => (value == null ? null : { index, value }))
      .filter((row): row is { index: number; value: number } => row != null);
    if (points.length < 2) return;
    this.ensure(80);
    const max = Math.max(...points.map((row) => row.value), 1);
    const min = Math.min(...points.map((row) => row.value), 0);
    const span = max - min || 1;
    const left = 48;
    const bottom = this.y - 64;
    const width = 516;
    const height = 56;
    this.color(0.9, 0.92, 0.93);
    this.rect(left, bottom, width, height);
    const lastIndex = Math.max(values.length - 1, 1);
    const ops = points.map((row, index) => {
      const x = left + (row.index / lastIndex) * width;
      const y = bottom + ((row.value - min) / span) * height;
      return `${x.toFixed(1)} ${y.toFixed(1)} ${index === 0 ? "m" : "l"}`;
    });
    this.current.push("0.25 0.72 0.86 RG");
    this.current.push("1.5 w");
    this.current.push(`${ops.join(" ")} S`);
    this.color(0.12, 0.14, 0.16);
    this.y = bottom - 16;
    if (labels[0]) this.text(48, this.y, labels[0], { size: 7 });
    if (labels.at(-1)) this.text(500, this.y, labels.at(-1)!, { size: 7 });
    this.y -= 18;
  }

  build(): Uint8Array {
    this.finishPage();
    this.pages.push(this.current.join("\n"));
    const objects: string[] = [];
    objects.push("<< /Type /Catalog /Pages 2 0 R >>");
    const pageIds: number[] = [];
    const fontStart = 3;
    objects.push(""); // pages placeholder
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
    const contentIds: number[] = [];
    for (const content of this.pages) {
      const stream = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
      const id = objects.length + 1;
      contentIds.push(id);
      objects.push(stream);
      const pageId = objects.length + 1;
      pageIds.push(pageId);
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${id} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`);
    }
    objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
    let body = "%PDF-1.4\n";
    const offsets = [0];
    for (let i = 0; i < objects.length; i += 1) {
      offsets.push(body.length);
      body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xref = body.length;
    body += `xref\n0 ${objects.length + 1}\n`;
    body += "0000000000 65535 f \n";
    for (let i = 1; i <= objects.length; i += 1) {
      body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new TextEncoder().encode(body);
  }
}

function kpiValue(kpi: ReportKpi): string {
  if (kpi.value == null) return "—";
  if (kpi.unit === "percent") return `${(kpi.value * 100).toFixed(1)}%`;
  if (kpi.unit === "cents") return `$${(kpi.value / 100).toFixed(2)}`;
  if (kpi.unit === "bytes") return `${kpi.value}`;
  return String(kpi.value);
}

function sectionMetrics(section: unknown): Array<{ key: string; label?: string; value: number | null; previous: number | null; availability: string }> {
  const metrics = (section as { metrics?: Array<{ key: string; label?: string; value: number | null; previous: number | null; availability: string }> } | undefined)?.metrics;
  return metrics ?? [];
}

function dumpMetrics(doc: PdfDoc, title: string, section: unknown) {
  const metrics = sectionMetrics(section);
  doc.heading(title);
  if (!metrics.length) {
    doc.para("No tracked data for this section in the selected period.");
    return;
  }
  doc.table(
    ["Metric", "Value", "Previous", "Availability"],
    metrics.slice(0, 16).map((item) => [item.label ?? item.key, item.value == null ? "—" : String(item.value), item.previous == null ? "—" : String(item.previous), item.availability]),
  );
}

export function renderReportPdf(row: AnalyticsReportRow): Uint8Array {
  const snap = row.metrics_json;
  const insights = row.insights_json as ReportInsight[];
  const recs = row.recommendations_json as ReportRecommendation[];
  const summary = row.summary_json as { executive?: string; attention?: string[] };
  const doc = new PdfDoc(`${snap.meta.title}  ·  ${snap.meta.label}  ·  Replayr`);
  doc.y = 700;
  doc.text(48, doc.y, "Replayr Analytics Report", { size: 22, bold: true });
  doc.y -= 22;
  doc.text(48, doc.y, snap.meta.title, { size: 14 });
  doc.y -= 18;
  doc.para(`Period ${snap.meta.label}  ·  Generated ${snap.meta.generatedAt.slice(0, 10)}  ·  Version ${snap.meta.reportVersion}  ·  ${snap.meta.timezone}`);
  if (snap.comparison && snap.comparison.available === false) {
    doc.para(snap.comparison.reason || "No tracked data for previous period");
  }
  doc.heading("Executive Summary");
  doc.para(String(summary.executive || ""));
  doc.heading("Needs Attention");
  for (const item of summary.attention ?? ["No major issues detected in tracked data."]) doc.bullet(item);
  doc.heading("Key KPIs");
  doc.table(
    ["Metric", "Value", "Previous", "Availability"],
    snap.kpis.map((item) => [item.label, kpiValue(item), item.previous == null ? "—" : String(item.previous), item.availability]),
  );
  doc.heading("Downloads");
  if (snap.downloads.tracking.notice) doc.para(snap.downloads.tracking.notice);
  doc.table(
    ["Channel", "Metric", "Value"],
    [
      ["App", "Download button clicks", String(snap.downloads.app.app_download_clicks ?? "—")],
      ["App", "Installer downloads", String(snap.downloads.app.installer_downloads ?? "—")],
      ["Media", "Authenticated clip downloads", String(snap.downloads.media.clip_downloads_authenticated ?? "—")],
      ["Media", "Public clip downloads", String(snap.downloads.media.clip_downloads_public ?? "—")],
      ["Media", "Public folder downloads", String(snap.downloads.media.folder_public_downloads ?? "—")],
      ["Media", "Media downloads total", String(snap.downloads.mediaTotal ?? "—")],
    ],
  );
  if (snap.downloads.stats.highest) {
    doc.para(`Highest tracked installer-download day: ${snap.downloads.stats.highest.day} (${snap.downloads.stats.highest.value}). Lowest: ${snap.downloads.stats.lowest?.day ?? "—"} (${snap.downloads.stats.lowest?.value ?? "—"}). Average: ${snap.downloads.stats.average == null ? "—" : snap.downloads.stats.average.toFixed(2)}.`);
  }
  doc.sparkline(snap.downloads.series.labels, snap.downloads.series.installer);
  dumpMetrics(doc, "Growth", snap.sections.growth);
  dumpMetrics(doc, "Retention", snap.sections.retention);
  dumpMetrics(doc, "Acquisition", snap.sections.acquisition);
  dumpMetrics(doc, "Clips", snap.sections.clips);
  const games = ((snap.sections.games as { games?: Array<{ name: string; cloudClips: number; slug: string }> })?.games ?? []).slice(0, 10);
  doc.heading("Games");
  if (games.length) {
    doc.table(
      ["Game", "Cloud clips", "Slug"],
      games.map((item) => [item.name, String(item.cloudClips), item.slug]),
    );
  } else {
    doc.para("No tracked game data for this period. Unknown remains a visible bucket when present.");
  }
  dumpMetrics(doc, "Features / Filters", snap.sections.features);
  const filters = ((snap.sections.features as { filters?: Array<{ id?: string; name?: string; applications?: number }> })?.filters ?? []).slice(0, 8);
  if (filters.length) {
    doc.table(
      ["Filter", "Applications"],
      filters.map((item) => [String(item.name ?? item.id ?? "unknown"), String(item.applications ?? "—")]),
    );
  } else {
    doc.para("Filter leaderboard omitted: no sufficient live filter events in this snapshot.");
  }
  dumpMetrics(doc, "Folders / Sharing", snap.sections.folders);
  dumpMetrics(doc, "Sharing", snap.sections.sharing);
  dumpMetrics(doc, "Revenue", snap.sections.revenue);
  doc.para("Estimated MRR is an estimate, not revenue. Authoritative MRR stays unavailable without paid Stripe amounts.");
  dumpMetrics(doc, "Infrastructure", snap.sections.infrastructure);
  doc.para("Bandwidth is not instrumented. Bunny/R2 transfer is not fabricated.");
  dumpMetrics(doc, "Product Health", snap.sections.health);
  doc.para("Raw exception traces are not included. Inspect /admin/errors for technical detail.");
  doc.heading("Insights");
  for (const item of insights) doc.bullet(item.text);
  if (!insights.length) doc.para("No data-grounded insights met the current thresholds.");
  doc.heading("Recommendations");
  for (const item of recs) doc.bullet(`[${item.priority}] ${item.title}: ${item.text}`);
  if (!recs.length) doc.para("No recommendations met the current thresholds.");
  doc.heading("Data Coverage");
  doc.table(
    ["Item", "Status", "Note"],
    snap.coverage.map((item) => [item.label, item.status, item.note]),
  );
  return doc.build();
}

export function pdfContainsForbidden(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes);
  return /stack trace|sk_live|Bearer |eyJ[A-Za-z0-9_-]{20,}|storage_key|Authorization/i.test(text);
}
