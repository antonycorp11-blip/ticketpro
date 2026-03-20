import { createClient } from '@supabase/supabase-js';
const SUPABASE_URL = 'https://wayigtlilhvutbfvxgae.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndheWlndGxpbGh2dXRiZnZ4Z2FlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1MDUwODQsImV4cCI6MjA4NDA4MTA4NH0.T26a6WAF4R7UlxN8lRHqoh_QEpc3SZqa97NhOlXQfbI';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function test() {
  const { error } = await supabase.from('ticketmaster_sales').upsert({
    id: "TKT-TEST-123",
    participant_name: "Test",
    payment_method: "Pix",
    value: 50.00,
    timestamp: new Date().toISOString(),
    pdf_generated: true,
    synced: true,
  }, { onConflict: 'id' });
  if (error) console.error("Error:", error);
  else console.log("Success!");
}
test();
