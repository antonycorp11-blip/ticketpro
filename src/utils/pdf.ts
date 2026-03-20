import { Sale, EventConfig } from '../types';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import * as XLSX from 'xlsx';

// ─── jsPDF lazy import ────────────────────────────────────────────────────────
async function getJsPDF() {
  const { jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  return { jsPDF, autoTable };
}

// ─── ID GENERATOR ─────────────────────────────────────────────────────────────
export function generateSaleId(participantName: string, timestamp: Date = new Date()): string {
  const namePart = participantName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .substring(0, 12);

  const datePart = format(timestamp, 'ddMMyyyy');
  const timePart = format(timestamp, 'HHmmss');
  return `TKT-${namePart}-${datePart}-${timePart}`;
}

// ─── IMAGE COMPRESSION ────────────────────────────────────────────────────────
/**
 * Comprime e redimensiona uma imagem para uso no PDF e no preview.
 * Retorna base64 JPEG.
 */
export function compressImage(file: File, maxWidth = 800, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, maxWidth / img.width);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target!.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ─── TICKET PDF ───────────────────────────────────────────────────────────────
/*
  Layout do Ingresso (80mm x 150mm):
  ┌─────────────────────────────────┐
  │  [BANNER DO EVENTO - 80x35mm]  │  → imagem do evento ou fundo verde gradiente
  │     sobreposição: nome evento   │
  ├─────────────────────────────────┤
  │  INGRESSO INDIVIDUAL            │
  │  ─────────────────────────────  │
  │  PARTICIPANTE                   │
  │  JOÃO SILVA                     │
  │  ─────────────────────────────  │
  │  VALOR         PAGAMENTO        │
  │  R$ 50,00      PIX              │
  │  ─────────────────────────────  │
  │  ID DO INGRESSO:                │
  │  TKT-JOAOSILVA-20032026-075423  │
  │  Data/Hora: 20/03/2026 07:54    │
  │  ─────────────────────────────  │
  │  [ VALIDAÇÃO ] ░░░░░░ ░░░░░░   │
  │  Apresente este ticket na entrada│
  └─────────────────────────────────┘
*/
export const generateTicketPDF = async (sale: Sale, event: EventConfig): Promise<void> => {
  try {
    const { jsPDF } = await getJsPDF();

    const TICKET_W = 80;
    const TICKET_H = 150;
    const BANNER_H = 36;
    const MARGIN  = 6;
    const MID     = TICKET_W / 2;

    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: [TICKET_W, TICKET_H],
    });

    // ── 1. BANNER / HEADER ──────────────────────────────────────────────────
    let hasCustomBanner = false;
    if (event.bannerImage) {
      // Imagem do banner carregada pelo usuário
      try {
        doc.addImage(event.bannerImage, 'JPEG', 0, 0, TICKET_W, BANNER_H);
        hasCustomBanner = true;
      } catch {
        drawFallbackBanner(doc, TICKET_W, BANNER_H, MID, event.name);
      }
    } else {
      drawFallbackBanner(doc, TICKET_W, BANNER_H, MID, event.name);
    }

    // Só desenha o overlay escuro e os textos (nome/data) se NÃO houver imagem customizada
    // Assim a imagem do usuário fica 100% visível, limpa e em alta resolução
    if (!hasCustomBanner) {
      doc.setFillColor(0, 0, 0);
      // @ts-ignore
      doc.setGState(new (doc as any).GState({ opacity: 0.45 }));
      doc.rect(0, 0, TICKET_W, BANNER_H, 'F');
      // @ts-ignore
      doc.setGState(new (doc as any).GState({ opacity: 1 }));

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(255, 255, 255);
      const eventNameLines = doc.splitTextToSize(event.name.toUpperCase(), TICKET_W - MARGIN * 2);
      const textStartY = BANNER_H / 2 - (eventNameLines.length * 5) / 2 + 3;
      doc.text(eventNameLines, MID, textStartY, { align: 'center' });

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(200, 255, 220);
      doc.text(
        `📅  ${formatDateBR(event.date)}`,
        MID, BANNER_H - 5,
        { align: 'center' }
      );
    }

    // Badge "INGRESSO OFICIAL" no canto superior direito
    doc.setFillColor(16, 185, 129);
    doc.roundedRect(TICKET_W - 30, 3, 27, 7, 1.5, 1.5, 'F');
    doc.setFontSize(5.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text('INGRESSO OFICIAL', TICKET_W - 16.5, 7.5, { align: 'center' });

    // ── 2. SEPARADOR DENTADO (tear-off) ─────────────────────────────────────
    const tearY = BANNER_H + 1;
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.3);
    doc.setLineDashPattern([1.5, 1.5], 0);
    doc.line(MARGIN, tearY, TICKET_W - MARGIN, tearY);
    doc.setLineDashPattern([], 0);

    // Círculos de margem (efeito ticket físico)
    doc.setFillColor(0, 0, 0);
    doc.circle(0, tearY, 2.5, 'F');
    doc.circle(TICKET_W, tearY, 2.5, 'F');

    // ── 3. DADOS DO PARTICIPANTE ─────────────────────────────────────────────
    let curY = tearY + 8;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(140, 140, 140);
    doc.text('PARTICIPANTE', MARGIN, curY);

    curY += 5;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(20, 20, 20);
    const nameLines = doc.splitTextToSize(sale.participantName.toUpperCase(), TICKET_W - MARGIN * 2);
    doc.text(nameLines, MARGIN, curY);
    curY += nameLines.length * 5 + 3;

    // Linha divisória
    drawDivider(doc, MARGIN, curY, TICKET_W - MARGIN);
    curY += 5;

    // ── 4. VALOR + PAGAMENTO em colunas ─────────────────────────────────────
    doc.setFontSize(7);
    doc.setTextColor(140, 140, 140);
    doc.setFont('helvetica', 'normal');
    doc.text('VALOR', MARGIN, curY);
    doc.text('PAGAMENTO', MID + 2, curY);

    curY += 5;
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(16, 185, 129); // emerald
    doc.text(`R$ ${sale.value.toFixed(2)}`, MARGIN, curY);

    // Badge de pagamento
    const payW = 22;
    const payX = MID + 2;
    doc.setFillColor(243, 244, 246);
    doc.roundedRect(payX, curY - 4.5, payW, 7, 1.5, 1.5, 'F');
    doc.setFontSize(8);
    doc.setTextColor(40, 40, 40);
    doc.text(sale.paymentMethod.toUpperCase(), payX + payW / 2, curY, { align: 'center' });

    curY += 7;
    drawDivider(doc, MARGIN, curY, TICKET_W - MARGIN);
    curY += 5;

    // ── 5. ID DO INGRESSO ────────────────────────────────────────────────────
    doc.setFontSize(6.5);
    doc.setTextColor(140, 140, 140);
    doc.setFont('helvetica', 'normal');
    doc.text('ID DO INGRESSO', MARGIN, curY);

    curY += 4.5;
    doc.setFont('courier', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(40, 40, 40);
    // Quebra o ID se for muito longo
    const idLines = doc.splitTextToSize(sale.id, TICKET_W - MARGIN * 2);
    doc.text(idLines, MARGIN, curY);
    curY += idLines.length * 4 + 2;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(140, 140, 140);
    doc.text(
      format(new Date(sale.timestamp), "dd/MM/yyyy  HH:mm:ss", { locale: ptBR }),
      MARGIN, curY
    );
    curY += 6;

    drawDivider(doc, MARGIN, curY, TICKET_W - MARGIN);
    curY += 6;

    // ── 6. QR PLACEHOLDER + RODAPÉ ──────────────────────────────────────────
    // Caixa de validação estilizada
    const qrSize = 18;
    const qrX = (TICKET_W - qrSize) / 2;
    doc.setDrawColor(16, 185, 129);
    doc.setLineWidth(0.5);
    doc.roundedRect(qrX, curY, qrSize, qrSize, 2, 2);

    // Padrão QR simulado (visual)
    doc.setFillColor(20, 20, 20);
    const cellSz = 2;
    const pattern = [
      [1,1,1,0,1,1,1],
      [1,0,1,0,1,0,1],
      [1,1,1,0,1,1,1],
      [0,0,0,0,0,0,0],
      [1,1,1,0,1,1,1],
      [1,0,1,0,1,0,1],
      [1,1,1,0,1,1,1],
    ];
    const qrInnerX = qrX + 2;
    const qrInnerY = curY + 2;
    pattern.forEach((row, ri) =>
      row.forEach((cell, ci) => {
        if (cell) doc.rect(qrInnerX + ci * cellSz, qrInnerY + ri * cellSz, cellSz - 0.2, cellSz - 0.2, 'F');
      })
    );

    // Label abaixo do QR
    doc.setFontSize(5.5);
    doc.setTextColor(100, 100, 100);
    doc.setFont('helvetica', 'normal');
    doc.text('VALIDAÇÃO NA ENTRADA', MID, curY + qrSize + 4, { align: 'center' });

    // Linha final
    const footerY = TICKET_H - 6;
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.2);
    doc.line(MARGIN, footerY - 2, TICKET_W - MARGIN, footerY - 2);
    doc.setFontSize(5.5);
    doc.setTextColor(160, 160, 160);
    doc.text('Apresente este ticket na entrada do evento.', MID, footerY, { align: 'center' });

    doc.save(`ingresso_${sale.id}.pdf`);
  } catch (err) {
    console.error('Erro ao gerar PDF do ingresso:', err);
    throw err;
  }
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function drawFallbackBanner(
  doc: InstanceType<Awaited<ReturnType<typeof getJsPDF>>['jsPDF']>,
  w: number, h: number, mid: number, eventName: string
) {
  // Fundo verde escuro gradiente simulado com dois retângulos
  doc.setFillColor(5, 46, 22);  // dark green
  doc.rect(0, 0, w, h, 'F');
  doc.setFillColor(6, 78, 37);
  doc.rect(0, h * 0.55, w, h * 0.45, 'F');

  // Linha decorativa
  doc.setDrawColor(16, 185, 129);
  doc.setLineWidth(0.5);
  doc.line(6, h - 8, w - 6, h - 8);
}

function drawDivider(doc: any, x1: number, y: number, x2: number) {
  doc.setDrawColor(230, 230, 230);
  doc.setLineWidth(0.2);
  doc.line(x1, y, x2, y);
}

function formatDateBR(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split('-');
    return `${d}/${m}/${y}`;
  } catch {
    return dateStr;
  }
}

// ─── REPORT PDF ───────────────────────────────────────────────────────────────
export const generateReportPDF = async (sales: Sale[], event: EventConfig): Promise<void> => {
  try {
    const { jsPDF, autoTable } = await getJsPDF();
    const doc = new jsPDF();
    const totalArrecadado = sales.reduce((acc, s) => acc + s.value, 0);

    // Header com banner (se houver) no relatório
    const REPORT_HEADER_H = 28;
    if (event.bannerImage) {
      try {
        doc.addImage(event.bannerImage, 'JPEG', 0, 0, 210, REPORT_HEADER_H);
        doc.setFillColor(0, 0, 0);
        // @ts-ignore
        doc.setGState(new (doc as any).GState({ opacity: 0.5 }));
        doc.rect(0, 0, 210, REPORT_HEADER_H, 'F');
        // @ts-ignore
        doc.setGState(new (doc as any).GState({ opacity: 1 }));
      } catch { /* usa fundo padrão */ }
    } else {
      doc.setFillColor(5, 46, 22);
      doc.rect(0, 0, 210, REPORT_HEADER_H, 'F');
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(255, 255, 255);
    doc.text(`Relatório de Vendas`, 14, 12);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(event.name, 14, 19);
    doc.text(`Data: ${formatDateBR(event.date)}`, 14, 25);

    const startY = REPORT_HEADER_H + 10;
    doc.setTextColor(30, 30, 30);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('Resumo', 14, startY);

    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`Total de Ingressos: ${sales.length}`, 14, startY + 7);
    doc.text(`Total Arrecadado: R$ ${totalArrecadado.toFixed(2)}`, 14, startY + 14);

    const tableData = sales.map(s => [
      s.id,
      s.participantName,
      s.paymentMethod,
      `R$ ${s.value.toFixed(2)}`,
      format(new Date(s.timestamp), "dd/MM/yyyy HH:mm:ss"),
      s.synced ? 'Sim' : 'Pendente',
    ]);

    autoTable(doc, {
      startY: startY + 22,
      head: [['ID', 'Participante', 'Pagamento', 'Valor', 'Data/Hora', 'Sync']],
      body: tableData,
      styles: { fontSize: 7 },
      headStyles: { fillColor: [16, 185, 129], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 250, 247] },
    });

    doc.save(`relatorio_${event.name.replace(/\s+/g, '_')}.pdf`);
  } catch (err) {
    console.error('Erro ao gerar PDF do relatório:', err);
    throw err;
  }
};

// ─── EXCEL EXPORT ─────────────────────────────────────────────────────────────
export const exportToExcel = (sales: Sale[], event: EventConfig): void => {
  const salesRows = sales.map(s => ({
    'ID do Ingresso': s.id,
    'Participante': s.participantName,
    'Pagamento': s.paymentMethod,
    'Valor (R$)': s.value,
    'Data/Hora': format(new Date(s.timestamp), "dd/MM/yyyy HH:mm:ss"),
    'PDF Gerado': s.pdfGenerated ? 'Sim' : 'Não',
    'Sincronizado': s.synced ? 'Sim' : 'Pendente',
  }));

  const byPayment = sales.reduce((acc, s) => {
    acc[s.paymentMethod] = (acc[s.paymentMethod] || 0) + s.value;
    return acc;
  }, {} as Record<string, number>);

  const summaryRows: Record<string, string | number>[] = [
    { 'Item': 'Evento', 'Valor': event.name },
    { 'Item': 'Data do Evento', 'Valor': formatDateBR(event.date) },
    { 'Item': 'Total de Ingressos', 'Valor': sales.length },
    { 'Item': 'Total Arrecadado (R$)', 'Valor': sales.reduce((a, s) => a + s.value, 0) },
    { 'Item': '', 'Valor': '' },
    { 'Item': 'Por Forma de Pagamento', 'Valor': '' },
    ...Object.entries(byPayment).map(([method, total]) => ({
      'Item': method,
      'Valor': total,
    })),
  ];

  const wb = XLSX.utils.book_new();

  const wsSales = XLSX.utils.json_to_sheet(salesRows);
  wsSales['!cols'] = [
    { wch: 35 }, { wch: 25 }, { wch: 12 },
    { wch: 12 }, { wch: 20 }, { wch: 12 }, { wch: 14 },
  ];
  XLSX.utils.book_append_sheet(wb, wsSales, 'Vendas');

  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 25 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Resumo');

  const fileName = `ticketmaster_${event.name.replace(/\s+/g, '_')}_${format(new Date(), 'ddMMyyyy_HHmm')}.xlsx`;
  XLSX.writeFile(wb, fileName);
};
