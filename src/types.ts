export type PaymentMethod = 'Pix' | 'Dinheiro' | 'Cartão';

export interface Sale {
  id: string;           // ex: "TKT-JOAOSILVA-20032026-075423"
  participantName: string;
  paymentMethod: PaymentMethod;
  value: number;
  timestamp: string;    // ISO string
  pdfGenerated: boolean;
  synced: boolean;      // true = enviado ao Supabase, false = pendente
}

export interface EventConfig {
  name: string;
  date: string;
  goal: number;
  defaultTicketPrice: number;
  bannerImage?: string; // base64 data URL (JPEG/PNG comprimido)
}
