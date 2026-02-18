const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const BRAND = {
  lime: 'C8F135',
  black: '0A0A0A',
  gray: '374151',
  lightGray: 'F3F4F6',
  white: 'FFFFFF'
};

// ─── CSV ─────────────────────────────────────────────────────────────────────

/**
 * Convert array of objects to CSV string with BOM (UTF-8 Excel compatible)
 */
function generateCSV(data, columns) {
  if (!data || data.length === 0) return '\uFEFF';

  const cols = columns || Object.keys(data[0]);
  const escape = (v) => {
    const str = v == null ? '' : String(v);
    return str.includes(',') || str.includes('"') || str.includes('\n')
      ? `"${str.replace(/"/g, '""')}"`
      : str;
  };

  const header = cols.join(',');
  const rows = data.map(row => cols.map(c => escape(row[c])).join(','));
  return '\uFEFF' + [header, ...rows].join('\r\n');
}

// ─── EXCEL ────────────────────────────────────────────────────────────────────

/**
 * Build an XLSX workbook from report data.
 * sheets: [{ name, columns: [{header,key,width}], rows: [...] }]
 * Returns a Buffer.
 */
async function generateExcel(reportTitle, sheets) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'RepMeUp';
  workbook.created = new Date();

  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name, {
      properties: { tabColor: { argb: BRAND.lime } },
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    ws.columns = sheet.columns;

    // Styled header row
    const headerRow = ws.getRow(1);
    headerRow.height = 28;
    sheet.columns.forEach((col, idx) => {
      const cell = headerRow.getCell(idx + 1);
      cell.value = col.header;
      cell.font = { bold: true, color: { argb: BRAND.black }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.lime } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        bottom: { style: 'medium', color: { argb: BRAND.black } }
      };
    });

    // Data rows
    sheet.rows.forEach((row, rowIdx) => {
      const wsRow = ws.addRow(row);
      wsRow.height = 20;
      const fill = rowIdx % 2 === 0 ? BRAND.lightGray : BRAND.white;
      wsRow.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        cell.alignment = { vertical: 'middle' };
        cell.font = { color: { argb: BRAND.black }, size: 10 };
      });
    });

    ws.autoFilter = { from: 'A1', to: ws.getCell(1, sheet.columns.length).address };
  }

  return workbook.xlsx.writeBuffer();
}

// ─── PDF ──────────────────────────────────────────────────────────────────────

const PDF_MARGIN     = 50;
const PDF_ROW_H      = 22;   // data row height
const PDF_HDR_H      = 26;   // table header height
const PDF_SEC_HDR_H  = 26;   // section heading height
const PDF_KPI_H      = 60;   // KPI box height
const PDF_FOOTER_H   = 36;
const PDF_CONTENT_BOTTOM = 841 - PDF_MARGIN - PDF_FOOTER_H; // A4 height minus margins/footer

/**
 * Move cursor to `y` and draw, keeping it clean.
 * All drawing helpers take an explicit `y` so doc.y is only used for reading,
 * never written via negative offsets.
 */
function generatePDF(reportData) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: PDF_MARGIN, bottom: PDF_MARGIN + PDF_FOOTER_H, left: PDF_MARGIN, right: PDF_MARGIN },
      autoFirstPage: true,
      bufferPages: true   // required for footer loop
    });

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { title, dateRange, sections } = reportData;
    const pageW    = doc.page.width;
    const contentW = pageW - PDF_MARGIN * 2;  // 495 on A4

    // ── helpers ──────────────────────────────────────────────────────────────

    /** Ensure at least `needed` pts of space remain; add page if not */
    function ensureSpace(needed) {
      if (doc.y + needed > PDF_CONTENT_BOTTOM) {
        doc.addPage();
        doc.y = PDF_MARGIN + 10;
      }
    }

    /** Draw filled rect without touching cursor */
    function fillRect(x, y, w, h, color) {
      doc.save().rect(x, y, w, h).fill(color).restore();
    }

    /** Draw text at exact (x, y) without moving cursor after */
    function drawText(str, x, y, opts = {}) {
      doc.save();
      doc.text(str, x, y, { lineBreak: false, ...opts });
      doc.restore();
    }

    /** Advance the cursor explicitly */
    function advanceTo(y) {
      doc.y = y;
    }

    // ── Header bar ────────────────────────────────────────────────────────────
    fillRect(0, 0, pageW, 72, '#0A0A0A');

    doc.font('Helvetica-Bold').fontSize(24).fillColor('#C8F135');
    drawText('RepMeUp', PDF_MARGIN, 16);

    doc.font('Helvetica').fontSize(10).fillColor('#9CA3AF');
    drawText('Analytics Report', PDF_MARGIN, 46);

    const genDate = new Date().toLocaleDateString('en-GB');
    doc.font('Helvetica').fontSize(9).fillColor('#9CA3AF');
    drawText(`Generated: ${genDate}`, PDF_MARGIN, 46, { width: contentW, align: 'right' });

    advanceTo(90);

    // ── Report title ──────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#0A0A0A');
    drawText(title, PDF_MARGIN, doc.y);
    advanceTo(doc.y + 24);

    if (dateRange) {
      doc.font('Helvetica').fontSize(10).fillColor('#6B7280');
      drawText(`Period: ${dateRange.start}  →  ${dateRange.end}`, PDF_MARGIN, doc.y);
      advanceTo(doc.y + 16);
    }

    // ── Lime divider ──────────────────────────────────────────────────────────
    advanceTo(doc.y + 6);
    doc.save().moveTo(PDF_MARGIN, doc.y).lineTo(PDF_MARGIN + contentW, doc.y)
       .strokeColor('#C8F135').lineWidth(2).stroke().restore();
    advanceTo(doc.y + 16);

    // ── Sections ──────────────────────────────────────────────────────────────
    for (const section of sections || []) {

      // ── Section heading bar
      ensureSpace(PDF_SEC_HDR_H + 10);
      const secY = doc.y;
      fillRect(PDF_MARGIN, secY, contentW, PDF_SEC_HDR_H, '#0A0A0A');

      // Vertically centre the label inside the bar
      const secTextY = secY + (PDF_SEC_HDR_H - 11) / 2;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#C8F135');
      drawText(section.title, PDF_MARGIN + 10, secTextY, { width: contentW - 20 });
      advanceTo(secY + PDF_SEC_HDR_H + 12);

      // ── KPI metric boxes ────────────────────────────────────────────────────
      if (section.metrics?.length) {
        const count  = Math.min(section.metrics.length, 4);
        const colW   = contentW / count;
        const boxGap = 6;
        ensureSpace(PDF_KPI_H + 16);
        const kpiY = doc.y;

        section.metrics.slice(0, count).forEach((m, i) => {
          const bx = PDF_MARGIN + i * colW;
          const bw = colW - boxGap;

          // Box background
          fillRect(bx, kpiY, bw, PDF_KPI_H, '#F3F4F6');

          // Lime top accent
          fillRect(bx, kpiY, bw, 3, '#C8F135');

          // Value (large, centred)
          doc.font('Helvetica-Bold').fontSize(16).fillColor('#0A0A0A');
          drawText(String(m.value), bx + 6, kpiY + 10, { width: bw - 12, align: 'center' });

          // Label (small, centred)
          doc.font('Helvetica').fontSize(8).fillColor('#6B7280');
          drawText(m.label, bx + 6, kpiY + 36, { width: bw - 12, align: 'center' });
        });

        advanceTo(kpiY + PDF_KPI_H + 14);
      }

      // ── Data table ─────────────────────────────────────────────────────────
      if (section.table) {
        const { headers, rows } = section.table;
        if (!headers?.length) continue;

        const colW = contentW / headers.length;

        // Table header row
        ensureSpace(PDF_HDR_H + 4);
        const thY = doc.y;
        fillRect(PDF_MARGIN, thY, contentW, PDF_HDR_H, '#0A0A0A');

        headers.forEach((h, i) => {
          doc.font('Helvetica-Bold').fontSize(8).fillColor('#C8F135');
          const textY = thY + (PDF_HDR_H - 8) / 2;
          drawText(String(h), PDF_MARGIN + i * colW + 5, textY, { width: colW - 10 });
        });
        advanceTo(thY + PDF_HDR_H + 2);

        // Data rows
        (rows || []).forEach((row, rowIdx) => {
          ensureSpace(PDF_ROW_H + 2);

          const rowY     = doc.y;
          const rowColor = rowIdx % 2 === 0 ? '#F9FAFB' : '#FFFFFF';
          fillRect(PDF_MARGIN, rowY, contentW, PDF_ROW_H, rowColor);

          // Bottom border
          doc.save().moveTo(PDF_MARGIN, rowY + PDF_ROW_H)
             .lineTo(PDF_MARGIN + contentW, rowY + PDF_ROW_H)
             .strokeColor('#E5E7EB').lineWidth(0.5).stroke().restore();

          row.forEach((cell, i) => {
            doc.font('Helvetica').fontSize(8).fillColor('#111827');
            const cellY = rowY + (PDF_ROW_H - 8) / 2;
            drawText(String(cell ?? ''), PDF_MARGIN + i * colW + 5, cellY, { width: colW - 10 });
          });

          advanceTo(rowY + PDF_ROW_H + 1);
        });

        advanceTo(doc.y + 4); // small gap after table
      }

      advanceTo(doc.y + 18); // gap between sections
    }

    // ── Footer on every page ──────────────────────────────────────────────────
    const range = doc.bufferedPageRange();
    const year  = new Date().getFullYear();

    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const fY = doc.page.height - PDF_FOOTER_H;
      fillRect(0, fY, pageW, PDF_FOOTER_H, '#0A0A0A');

      doc.font('Helvetica').fontSize(8).fillColor('#9CA3AF');
      drawText(`© ${year} RepMeUp  •  Confidential`, PDF_MARGIN, fY + 12);
      drawText(`Page ${i + 1} of ${range.count}`, PDF_MARGIN, fY + 12, { width: contentW, align: 'right' });
    }

    doc.end();
  });
}

// ─── Report data formatters ───────────────────────────────────────────────────

function formatSentimentReport(analytics, dateRange) {
  const s = analytics.sentimentBreakdown || {};
  const total = (s.positive || 0) + (s.neutral || 0) + (s.negative || 0);

  const csvRows = (analytics.platformMetrics || []).map(p => ({
    Platform: p.platform,
    'Total Interactions': p.totalInteractions,
    Responded: p.responded,
    Pending: p.pending,
    'Avg Response Time (min)': Math.round(p.avgResponseTime || 0),
    'Sentiment Score': p.sentimentScore || 0
  }));

  const pdfSections = [
    {
      title: 'Sentiment Overview',
      metrics: [
        { label: 'Total Interactions', value: total.toLocaleString() },
        { label: 'Positive', value: `${s.positive || 0} (${total ? ((s.positive / total) * 100).toFixed(1) : 0}%)` },
        { label: 'Neutral', value: `${s.neutral || 0} (${total ? ((s.neutral / total) * 100).toFixed(1) : 0}%)` },
        { label: 'Negative', value: `${s.negative || 0} (${total ? ((s.negative / total) * 100).toFixed(1) : 0}%)` }
      ]
    },
    {
      title: 'Sentiment by Platform',
      table: {
        headers: ['Platform', 'Total', 'Responded', 'Pending', 'Sentiment Score'],
        rows: (analytics.platformMetrics || []).map(p => [
          p.platform, p.totalInteractions, p.responded, p.pending, `${p.sentimentScore || 0}%`
        ])
      }
    }
  ];

  const excelSheets = [
    {
      name: 'Sentiment Overview',
      columns: [
        { header: 'Metric', key: 'metric', width: 24 },
        { header: 'Value', key: 'value', width: 16 }
      ],
      rows: [
        { metric: 'Total Interactions', value: total },
        { metric: 'Positive', value: s.positive || 0 },
        { metric: 'Neutral', value: s.neutral || 0 },
        { metric: 'Negative', value: s.negative || 0 }
      ]
    },
    {
      name: 'By Platform',
      columns: [
        { header: 'Platform', key: 'Platform', width: 16 },
        { header: 'Total', key: 'Total Interactions', width: 14 },
        { header: 'Responded', key: 'Responded', width: 14 },
        { header: 'Pending', key: 'Pending', width: 14 },
        { header: 'Sentiment Score', key: 'Sentiment Score', width: 18 }
      ],
      rows: csvRows
    }
  ];

  return { csv: generateCSV(csvRows), excelSheets, pdfSections };
}

function formatResponseReport(analytics, dateRange) {
  const rt = analytics.responseTimeMetrics || {};
  const overview = analytics.overview || {};

  const csvRows = (analytics.platformMetrics || []).map(p => ({
    Platform: p.platform,
    'Total Interactions': p.totalInteractions,
    Responded: p.responded,
    'Response Rate (%)': p.totalInteractions ? ((p.responded / p.totalInteractions) * 100).toFixed(1) : 0,
    'Avg Response Time (min)': Math.round(p.avgResponseTime || 0)
  }));

  const pdfSections = [
    {
      title: 'Response Performance Overview',
      metrics: [
        { label: 'Avg Response Time', value: `${Math.round(rt.avg || 0)}m` },
        { label: 'Median', value: `${Math.round(rt.median || 0)}m` },
        { label: 'Within 1 Hour', value: (rt.within1Hour || 0).toLocaleString() },
        { label: 'Over 24 Hours', value: (rt.over24Hours || 0).toLocaleString() }
      ]
    },
    {
      title: 'Response by Platform',
      table: { headers: ['Platform', 'Total', 'Responded', 'Response Rate', 'Avg Time'], rows: csvRows.map(r => Object.values(r)) }
    }
  ];

  const excelSheets = [
    {
      name: 'Response Overview',
      columns: [
        { header: 'Metric', key: 'metric', width: 28 },
        { header: 'Value', key: 'value', width: 16 }
      ],
      rows: [
        { metric: 'Avg Response Time (min)', value: Math.round(rt.avg || 0) },
        { metric: 'Median Response Time (min)', value: Math.round(rt.median || 0) },
        { metric: 'Fastest (min)', value: Math.round(rt.fastest || 0) },
        { metric: 'Slowest (min)', value: Math.round(rt.slowest || 0) },
        { metric: 'Within 1 Hour', value: rt.within1Hour || 0 },
        { metric: 'Within 24 Hours', value: rt.within24Hours || 0 },
        { metric: 'Over 24 Hours', value: rt.over24Hours || 0 }
      ]
    },
    { name: 'By Platform', columns: Object.keys(csvRows[0] || {}).map(k => ({ header: k, key: k, width: 20 })), rows: csvRows }
  ];

  return { csv: generateCSV(csvRows), excelSheets, pdfSections };
}

function formatPlatformReport(analytics, dateRange) {
  const csvRows = (analytics.platformMetrics || []).map(p => ({
    Platform: p.platform,
    'Total Interactions': p.totalInteractions,
    Responded: p.responded,
    Pending: p.pending,
    'Avg Response Time (min)': Math.round(p.avgResponseTime || 0),
    'Sentiment Score': p.sentimentScore || 0,
    'Engagement Rate (%)': p.engagementRate || 0
  }));

  const pdfSections = [
    {
      title: 'Platform Comparison',
      table: {
        headers: ['Platform', 'Total', 'Responded', 'Pending', 'Avg Time', 'Sentiment'],
        rows: (analytics.platformMetrics || []).map(p => [
          p.platform, p.totalInteractions, p.responded, p.pending,
          `${Math.round(p.avgResponseTime || 0)}m`, `${p.sentimentScore || 0}%`
        ])
      }
    }
  ];

  const excelSheets = [
    { name: 'Platform Metrics', columns: Object.keys(csvRows[0] || {}).map(k => ({ header: k, key: k, width: 22 })), rows: csvRows }
  ];

  return { csv: generateCSV(csvRows), excelSheets, pdfSections };
}

function formatAgentReport(agentData, dateRange) {
  const agents = agentData?.agents || [];
  const csvRows = agents.map(a => ({
    Name: a.name,
    'Total Assigned': a.totalAssigned,
    'Total Resolved': a.totalResolved,
    'Resolution Rate (%)': a.totalAssigned ? ((a.totalResolved / a.totalAssigned) * 100).toFixed(1) : 0,
    'Avg Response Time (min)': Math.round(a.avgResponseTime || 0),
    'Performance Score': a.performanceScore || 0
  }));

  const pdfSections = [
    {
      title: 'Agent Performance Summary',
      table: {
        headers: ['Agent', 'Assigned', 'Resolved', 'Resolution Rate', 'Avg Time', 'Score'],
        rows: agents.map(a => [
          a.name, a.totalAssigned, a.totalResolved,
          `${a.totalAssigned ? ((a.totalResolved / a.totalAssigned) * 100).toFixed(1) : 0}%`,
          `${Math.round(a.avgResponseTime || 0)}m`,
          a.performanceScore || 0
        ])
      }
    }
  ];

  const excelSheets = [
    { name: 'Agent Performance', columns: Object.keys(csvRows[0] || {}).map(k => ({ header: k, key: k, width: 22 })), rows: csvRows }
  ];

  return { csv: generateCSV(csvRows), excelSheets, pdfSections };
}

module.exports = { generateCSV, generateExcel, generatePDF, formatSentimentReport, formatResponseReport, formatPlatformReport, formatAgentReport };
