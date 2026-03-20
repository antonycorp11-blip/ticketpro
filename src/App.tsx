import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Plus,
  LayoutDashboard,
  FileText,
  TrendingUp,
  CreditCard,
  DollarSign,
  Users,
  Search,
  Download,
  ArrowLeft,
  CheckCircle2,
  Settings,
  PieChart as PieChartIcon,
  BarChart as BarChartIcon,
  Activity,
  Eye,
  EyeOff,
  Wifi,
  WifiOff,
  FileSpreadsheet,
  AlertCircle,
  RefreshCw,
  Trash2,
  Lock,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { motion, AnimatePresence, useMotionValue, animate } from 'motion/react';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { Sale, EventConfig, PaymentMethod } from './types';
import { generateTicketPDF, generateReportPDF, exportToExcel, generateSaleId, compressImage } from './utils/pdf';
import { supabase } from './lib/supabase';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444'];
const LOCAL_STORAGE_SALES_KEY = 'ticketmaster_sales_v2';
const LOCAL_STORAGE_EVENT_KEY = 'ticketmaster_event_config';

// ─── SYNC HELPERS ─────────────────────────────────────────────────────────────

async function syncPendingSales(localSales: Sale[]): Promise<Sale[]> {
  const pending = localSales.filter(s => !s.synced);
  if (pending.length === 0) return localSales;

  const rows = pending.map(s => ({
    id: s.id,
    participant_name: s.participantName,
    payment_method: s.paymentMethod,
    value: s.value,
    timestamp: s.timestamp,
    pdf_generated: s.pdfGenerated,
    synced: true,
  }));

  const { error } = await supabase
    .from('ticketmaster_sales')
    .upsert(rows, { onConflict: 'id' });

  if (error) throw error;

  return localSales.map(s => s.synced ? s : { ...s, synced: true });
}

async function fetchRemoteSales(): Promise<Sale[]> {
  const { data, error } = await supabase
    .from('ticketmaster_sales')
    .select('*')
    .order('timestamp', { ascending: false });

  if (error) throw error;

  return (data ?? []).map(row => ({
    id: row.id,
    participantName: row.participant_name,
    paymentMethod: row.payment_method as PaymentMethod,
    value: Number(row.value),
    timestamp: row.timestamp,
    pdfGenerated: row.pdf_generated,
    synced: true,
  }));
}

async function syncEventConfig(event: EventConfig): Promise<void> {
  const { error } = await supabase
    .from('ticketmaster_event_config')
    .upsert({
      id: 'default',
      name: event.name,
      date: event.date,
      goal: event.goal,
      default_ticket_price: event.defaultTicketPrice,
      banner_image: event.bannerImage || null,
    });
  if (error) throw error;
}

async function fetchRemoteEventConfig(): Promise<EventConfig | null> {
  const { data, error } = await supabase
    .from('ticketmaster_event_config')
    .select('*')
    .eq('id', 'default')
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    name: data.name,
    date: data.date,
    goal: Number(data.goal),
    defaultTicketPrice: Number(data.default_ticket_price),
    bannerImage: data.banner_image || undefined,
  };
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

export default function App() {
  // --- State ---
  const [sales, setSales] = useState<Sale[]>([]);
  const [event, setEvent] = useState<EventConfig>({
    name: 'Evento Principal',
    date: format(new Date(), 'yyyy-MM-dd'),
    goal: 100,
    defaultTicketPrice: 50.00,
  });
  const [activeTab, setActiveTab] = useState<'dashboard' | 'sale' | 'reports' | 'settings'>('dashboard');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterPayment, setFilterPayment] = useState<PaymentMethod | 'Todos'>('Todos');
  const [showSuccess, setShowSuccess] = useState(false);
  const [hideFinancials, setHideFinancials] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [saleToDelete, setSaleToDelete] = useState<Sale | null>(null);
  const [eventChangedLocally, setEventChangedLocally] = useState(false);

  // --- Confirm Delete ---
  const handleConfirmDelete = async (password: string) => {
    if (password !== '1515') {
      showToast('Senha incorreta', 'error');
      return;
    }
    if (!saleToDelete) return;

    const idToDel = saleToDelete.id;
    setSales(prev => prev.filter(s => s.id !== idToDel));
    
    if (navigator.onLine && saleToDelete.synced) {
      try {
        await supabase.from('ticketmaster_sales').delete().eq('id', idToDel);
      } catch (err) {
        console.error('Erro ao deletar no remote', err);
      }
    }
    
    setSaleToDelete(null);
    showToast('Venda excluída com sucesso');
  };

  // --- Toast helper ---
  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // --- Online/offline tracking ---
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // --- Initial load: fetch from Supabase, merge with localStorage ---
  useEffect(() => {
    // Migração: se não tiver o v2, tenta ler do key antigo (localStorage)
    let savedEvent = localStorage.getItem(LOCAL_STORAGE_EVENT_KEY);
    if (!savedEvent) savedEvent = localStorage.getItem('event_config');
    let localEvent: EventConfig | null = savedEvent ? JSON.parse(savedEvent) : null;
    if (localEvent) setEvent(localEvent);

    let localRaw = localStorage.getItem(LOCAL_STORAGE_SALES_KEY);
    if (!localRaw) localRaw = localStorage.getItem('ticket_sales'); // Key antigo (V1)
    
    // Na V1, a estrutura não tinha `synced`. Mapeamos pra garantir que seja sincronizado depois.
    let localSales: Sale[] = localRaw ? JSON.parse(localRaw) : [];
    // Mapeia para o novo formato caso venham do V1 (sem a prop `synced`)
    localSales = localSales.map(s => ({
      ...s,
      synced: s.synced ?? false 
    }));

    if (navigator.onLine) {
      (async () => {
        try {
          const remoteEvent = await fetchRemoteEventConfig();
          if (remoteEvent) {
            setEvent(remoteEvent);
            localStorage.setItem(LOCAL_STORAGE_EVENT_KEY, JSON.stringify(remoteEvent));
          } else if (localEvent) {
             await syncEventConfig(localEvent); // Cria a primeira vez caso ainda não tenha no banco
          }
        } catch (err) {
          console.error("Erro ao puxar event config no inicio", err);
        }

        try {
          const remoteSales = await fetchRemoteSales();
          // Merge: remote is source of truth; local pending records are added on top
          const localPending = localSales.filter(s => !s.synced);
          const remoteIds = new Set(remoteSales.map(s => s.id));
          const newPending = localPending.filter(s => !remoteIds.has(s.id));
          const merged = [...newPending, ...remoteSales];
          
          setSales(merged);
          localStorage.setItem(LOCAL_STORAGE_SALES_KEY, JSON.stringify(merged));
        } catch (err) {
          // Offline ou erro no Supabase — usa dados locais
          console.error("Erro ao puxar dados do Supabase na inicialização", err);
          setSales(localSales);
          localStorage.setItem(LOCAL_STORAGE_SALES_KEY, JSON.stringify(localSales));
        }
      })();
    } else {
      setSales(localSales);
      localStorage.setItem(LOCAL_STORAGE_SALES_KEY, JSON.stringify(localSales));
    }
  }, []);

  // --- Persist locally on every change ---
  useEffect(() => {
    localStorage.setItem(LOCAL_STORAGE_SALES_KEY, JSON.stringify(sales));
  }, [sales]);

  useEffect(() => {
    localStorage.setItem(LOCAL_STORAGE_EVENT_KEY, JSON.stringify(event));
  }, [event]);

  // --- Auto-sync Event Config (Debounced) ---
  useEffect(() => {
    if (!eventChangedLocally || !isOnline) return;
    const timeout = setTimeout(() => {
      syncEventConfig(event)
        .then(() => setEventChangedLocally(false))
        .catch(err => console.error("Erro no auto-sync do evento", err));
    }, 1500);
    return () => clearTimeout(timeout);
  }, [event, isOnline, eventChangedLocally]);

  // --- Auto-sync when coming back online ---
  useEffect(() => {
    if (!isOnline) return;

    if (eventChangedLocally) {
      syncEventConfig(event).then(() => setEventChangedLocally(false)).catch(console.error);
    }
    const hasPending = sales.some(s => !s.synced);
    if (!hasPending) return;

    setIsSyncing(true);
    setSyncError(null);
    syncPendingSales(sales)
      .then(updated => {
        setSales(updated);
        showToast('Dados sincronizados com sucesso!');
      })
      .catch(() => {
        setSyncError('Falha ao sincronizar. Tentando novamente em breve...');
      })
      .finally(() => setIsSyncing(false));
  }, [isOnline]);

  // --- Manual sync trigger ---
  const handleManualSync = async () => {
    if (!isOnline) { showToast('Sem conexão com a internet.', 'error'); return; }
    setIsSyncing(true);
    setSyncError(null);
    try {
      if (eventChangedLocally) {
        await syncEventConfig(event);
        setEventChangedLocally(false);
      }
      const updated = await syncPendingSales(sales);
      setSales(updated);
      showToast('Sincronizado com sucesso!');
    } catch {
      setSyncError('Falha ao sincronizar.');
      showToast('Erro ao sincronizar.', 'error');
    } finally {
      setIsSyncing(false);
    }
  };

  // --- Calculations ---
  const stats = useMemo(() => {
    const totalSold = sales.length;
    const totalRevenue = sales.reduce((acc, s) => acc + s.value, 0);
    const avgTicket = totalSold > 0 ? totalRevenue / totalSold : 0;
    const byPayment = sales.reduce((acc, s) => {
      acc[s.paymentMethod] = (acc[s.paymentMethod] || 0) + s.value;
      return acc;
    }, {} as Record<string, number>);
    const pendingSync = sales.filter(s => !s.synced).length;
    return { totalSold, totalRevenue, avgTicket, byPayment, pendingSync };
  }, [sales]);

  const chartData = useMemo(() => {
    const pieData = Object.entries(stats.byPayment).map(([name, value]) => ({ name, value }));
    const hourlyData: Record<string, number> = {};
    sales.forEach(s => {
      const hour = format(parseISO(s.timestamp), 'HH:00');
      hourlyData[hour] = (hourlyData[hour] || 0) + 1;
    });
    const lineData = Object.entries(hourlyData)
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => a.hour.localeCompare(b.hour));
    const paymentCounts = sales.reduce((acc, s) => {
      acc[s.paymentMethod] = (acc[s.paymentMethod] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const barData = Object.entries(paymentCounts).map(([name, count]) => ({ name, count }));
    return { pieData, lineData, barData };
  }, [sales, stats]);

  const filteredSales = useMemo(() => {
    return sales
      .filter(s =>
        (filterPayment === 'Todos' || s.paymentMethod === filterPayment) &&
        (s.participantName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.id.toLowerCase().includes(searchQuery.toLowerCase()))
      )
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [sales, searchQuery, filterPayment]);

  // --- Add Sale ---
  const handleAddSale = useCallback(async (
    participantName: string,
    paymentMethod: PaymentMethod,
    value: number,
    generatePDF: boolean
  ) => {
    const now = new Date();
    const newSale: Sale = {
      id: generateSaleId(participantName, now),
      participantName,
      paymentMethod,
      value,
      timestamp: now.toISOString(),
      pdfGenerated: generatePDF,
      synced: false, // will be synced shortly
    };

    // 1. Save locally first (offline-first)
    setSales(prev => [newSale, ...prev]);

    // 2. Generate PDF if requested
    if (generatePDF) {
      try {
        await generateTicketPDF(newSale, event);
      } catch {
        showToast('PDF não pôde ser gerado.', 'error');
      }
    }

    // 3. Try to sync with Supabase
    if (navigator.onLine) {
      try {
        const { error } = await supabase.from('ticketmaster_sales').upsert({
          id: newSale.id,
          participant_name: newSale.participantName,
          payment_method: newSale.paymentMethod,
          value: newSale.value,
          timestamp: newSale.timestamp,
          pdf_generated: newSale.pdfGenerated,
          synced: true,
        }, { onConflict: 'id' });
        
        if (error) {
          console.error("Erro ao salvar no Supabase:", error);
          throw error;
        }
        
        setSales(prev => prev.map(s => s.id === newSale.id ? { ...s, synced: true } : s));
      } catch {
        // Stays as synced: false — will sync when online
      }
    }

    setShowSuccess(true);
    setTimeout(() => {
      setShowSuccess(false);
      setActiveTab('dashboard');
    }, 1500);
  }, [event, showToast]);

  // ─── Render Dashboard ─────────────────────────────────────────────────────
  const renderDashboard = () => (
    <div className="space-y-6">
      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-zinc-900 border border-zinc-800 p-4 rounded-2xl">
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1">
            <Users size={14} />
            <span>VENDIDOS</span>
          </div>
          <div className="text-2xl font-bold text-white">{stats.totalSold}</div>
          <div className="mt-2 h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-500"
              style={{ width: `${Math.min((stats.totalSold / event.goal) * 100, 100)}%` }}
            />
          </div>
          <div className="text-[10px] text-zinc-500 mt-1">Meta: {event.goal}</div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 p-4 rounded-2xl relative">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2 text-zinc-400 text-xs">
              <DollarSign size={14} />
              <span>ARRECADADO</span>
            </div>
            <button
              onClick={() => setHideFinancials(h => !h)}
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
              title={hideFinancials ? 'Mostrar valores' : 'Ocultar valores'}
            >
              {hideFinancials ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <div className="text-2xl font-bold text-emerald-500">
            {hideFinancials ? '••••••' : `R$ ${stats.totalRevenue.toFixed(2)}`}
          </div>
          <div className="text-[10px] text-zinc-500 mt-1">
            Ticket Médio: {hideFinancials ? '••••' : `R$ ${stats.avgTicket.toFixed(2)}`}
          </div>
        </div>
      </div>

      {/* Pending sync badge */}
      {stats.pendingSync > 0 && (
        <div className="flex items-center gap-2 bg-amber-900/20 border border-amber-800/40 rounded-xl px-4 py-2.5">
          <WifiOff size={14} className="text-amber-500 flex-shrink-0" />
          <span className="text-xs text-amber-400 flex-1">
            {stats.pendingSync} venda{stats.pendingSync > 1 ? 's' : ''} pendente{stats.pendingSync > 1 ? 's' : ''} de sincronização
          </span>
          {isOnline && (
            <button
              onClick={handleManualSync}
              disabled={isSyncing}
              className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1"
            >
              <RefreshCw size={12} className={isSyncing ? 'animate-spin' : ''} />
              {isSyncing ? 'Sincronizando...' : 'Sincronizar'}
            </button>
          )}
        </div>
      )}

      {/* Sell Button */}
      <button
        onClick={() => setActiveTab('sale')}
        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-5 rounded-2xl flex items-center justify-center gap-3 shadow-lg shadow-emerald-900/20 transition-all active:scale-95"
      >
        <Plus size={24} />
        VENDER INGRESSO
      </button>

      {/* Recent Sales */}
      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-sm font-medium text-zinc-400">Vendas Recentes</h3>
          <button onClick={() => setActiveTab('reports')} className="text-xs text-emerald-500 hover:underline">
            Ver tudo
          </button>
        </div>
        <div className="space-y-1">
          {sales.slice(0, 5).map(sale => (
            <SwipeableSaleItem
              key={sale.id}
              sale={sale}
              hideFinancials={hideFinancials}
              onDeleteIntent={setSaleToDelete}
            />
          ))}
          {sales.length === 0 && (
            <div className="text-center py-8 text-zinc-600 italic text-sm">Nenhuma venda registrada</div>
          )}
        </div>
      </div>
    </div>
  );

  // ─── Render Sale Form ─────────────────────────────────────────────────────
  const renderSaleForm = () => (
    <SaleFormContent
      defaultPrice={event.defaultTicketPrice}
      onAddSale={handleAddSale}
      onCancel={() => setActiveTab('dashboard')}
    />
  );

  // ─── Render Reports ───────────────────────────────────────────────────────
  const renderReports = () => (
    <div className="space-y-8 pb-20">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Relatórios</h2>
        <div className="flex gap-2">
          <button
            onClick={() => generateReportPDF(sales, event).catch(() => showToast('Erro ao gerar PDF.', 'error'))}
            className="p-2 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-400 hover:text-emerald-500 transition-colors"
            title="Exportar PDF"
          >
            <Download size={18} />
          </button>
          <button
            onClick={() => {
              try { exportToExcel(sales, event); }
              catch { showToast('Erro ao exportar Excel.', 'error'); }
            }}
            className="p-2 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-400 hover:text-emerald-500 transition-colors"
            title="Exportar Excel (.xlsx)"
          >
            <FileSpreadsheet size={18} />
          </button>
        </div>
      </div>

      {/* Resumo Financeiro */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Resumo Financeiro</h3>
          <button
            onClick={() => setHideFinancials(h => !h)}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {hideFinancials ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <div className="grid grid-cols-1 gap-4">
          <div className="flex justify-between items-end border-b border-zinc-800 pb-3">
            <span className="text-zinc-400">Total Geral</span>
            <span className="text-2xl font-bold text-emerald-500">
              {hideFinancials ? '••••••' : `R$ ${stats.totalRevenue.toFixed(2)}`}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(Object.entries(stats.byPayment) as [string, number][]).map(([method, amount]) => (
              <div key={method} className="bg-zinc-950 p-2 rounded-lg border border-zinc-800">
                <div className="text-[10px] text-zinc-500 uppercase">{method}</div>
                <div className="text-xs font-bold text-white">
                  {hideFinancials ? '••••' : `R$ ${amount.toFixed(2)}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Gráficos */}
      <div className="space-y-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
          <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2">
            <Activity size={14} /> Vendas por Hora
          </h3>
          {chartData.lineData.length === 0 ? (
            <EmptyChart />
          ) : (
            <div className="h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData.lineData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="hour" stroke="#71717a" fontSize={10} />
                  <YAxis stroke="#71717a" fontSize={10} allowDecimals={false} />
                  <Tooltip contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }} itemStyle={{ color: '#10b981' }} />
                  <Line type="monotone" dataKey="count" stroke="#10b981" strokeWidth={3} dot={{ fill: '#10b981' }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
            <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2">
              <PieChartIcon size={14} /> Distribuição
            </h3>
            {chartData.pieData.length === 0 ? (
              <EmptyChart />
            ) : (
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={chartData.pieData} cx="50%" cy="50%" innerRadius={40} outerRadius={60} paddingAngle={5} dataKey="value">
                      {chartData.pieData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
            <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2">
              <BarChartIcon size={14} /> Quantidade
            </h3>
            {chartData.barData.length === 0 ? (
              <EmptyChart />
            ) : (
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData.barData}>
                    <XAxis dataKey="name" stroke="#71717a" fontSize={10} />
                    <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                    <Tooltip cursor={{ fill: '#27272a' }} contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Lista Detalhada */}
      <div className="space-y-4">
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-zinc-400">Lista Detalhada</h3>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={16} />
              <input
                type="text"
                placeholder="Buscar por nome ou ID..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-10 pr-4 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
            <select
              value={filterPayment}
              onChange={e => setFilterPayment(e.target.value as PaymentMethod | 'Todos')}
              className="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-400 focus:outline-none"
            >
              <option value="Todos">Todos</option>
              <option value="Pix">Pix</option>
              <option value="Dinheiro">Dinheiro</option>
              <option value="Cartão">Cartão</option>
            </select>
          </div>
        </div>

        <div className="space-y-1">
          {filteredSales.map(sale => (
            <SwipeableSaleItem
              key={sale.id}
              sale={sale}
              hideFinancials={hideFinancials}
              onDeleteIntent={setSaleToDelete}
            />
          ))}
          {filteredSales.length === 0 && (
            <div className="text-center py-12 text-zinc-600 italic">Nenhum resultado encontrado</div>
          )}
        </div>
      </div>
    </div>
  );

  // ─── Render Settings ──────────────────────────────────────────────────────
  const renderSettings = () => (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-white">Configurações</h2>

      {/* Banner do Evento */}
      <BannerUploader
        currentBanner={event.bannerImage}
        onBannerChange={base64 => { setEvent(prev => ({ ...prev, bannerImage: base64 })); setEventChangedLocally(true); }}
        onBannerRemove={() => { setEvent(prev => ({ ...prev, bannerImage: undefined })); setEventChangedLocally(true); }}
      />

      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-4">
        {[
          { label: 'Nome do Evento', key: 'name' as const, type: 'text' },
          { label: 'Data do Evento', key: 'date' as const, type: 'date' },
          { label: 'Meta de Vendas (Ingressos)', key: 'goal' as const, type: 'number' },
          { label: 'Valor Padrão do Ingresso (R$)', key: 'defaultTicketPrice' as const, type: 'number', step: '0.01' },
        ].map(({ label, key, type, step }) => (
          <div key={key} className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-500 uppercase tracking-wider">{label}</label>
            <input
              type={type}
              step={step}
              value={event[key]}
              onChange={e => {
                setEvent(prev => ({
                  ...prev,
                  [key]: type === 'number' ? (step ? parseFloat(e.target.value) || 0 : parseInt(e.target.value) || 0) : e.target.value,
                }));
                setEventChangedLocally(true);
              }}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-emerald-500 [color-scheme:dark]"
            />
          </div>
        ))}
      </div>

      {/* Sync Status */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-3">
        <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Status de Sincronização</h3>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isOnline
              ? <Wifi size={16} className="text-emerald-500" />
              : <WifiOff size={16} className="text-red-500" />}
            <span className="text-sm text-zinc-300">{isOnline ? 'Online' : 'Offline'}</span>
          </div>
          <div className="text-xs text-zinc-500">
            {stats.pendingSync} pendente{stats.pendingSync !== 1 ? 's' : ''}
          </div>
        </div>
        {isOnline && stats.pendingSync > 0 && (
          <button
            onClick={handleManualSync}
            disabled={isSyncing}
            className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium py-2.5 rounded-xl flex items-center justify-center gap-2 transition-all disabled:opacity-50"
          >
            <RefreshCw size={14} className={isSyncing ? 'animate-spin' : ''} />
            {isSyncing ? 'Sincronizando...' : 'Sincronizar Agora'}
          </button>
        )}
        {syncError && (
          <div className="flex items-center gap-2 text-xs text-red-400">
            <AlertCircle size={12} />
            {syncError}
          </div>
        )}
      </div>

      <div className="pt-2">
        <button
          onClick={() => {
            if (confirm('Tem certeza que deseja apagar TODAS as vendas locais? Dados já sincronizados com o Supabase serão mantidos lá.')) {
              setSales([]);
              localStorage.removeItem(LOCAL_STORAGE_SALES_KEY);
            }
          }}
          className="w-full bg-red-900/20 border border-red-900/50 text-red-500 font-medium py-4 rounded-2xl hover:bg-red-900/30 transition-all"
        >
          LIMPAR DADOS LOCAIS
        </button>
      </div>
    </div>
  );

  // ─── Main Render ──────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-black text-zinc-100 font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-black/80 backdrop-blur-md border-b border-zinc-800/50 px-6 py-4">
        <div className="flex items-center justify-between max-w-lg mx-auto">
          <div>
            <h1 className="text-lg font-black tracking-tighter text-white uppercase italic">
              TicketMaster<span className="text-emerald-500">PRO</span>
            </h1>
            <p className="text-[10px] text-zinc-500 font-medium uppercase tracking-widest">{event.name}</p>
          </div>
          <div className="flex items-center gap-2">
            {/* Online indicator */}
            <div className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-bold uppercase tracking-widest',
              isOnline
                ? 'bg-emerald-900/20 border-emerald-800/40 text-emerald-400'
                : 'bg-red-900/20 border-red-800/40 text-red-400'
            )}>
              {isOnline
                ? <><div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />LIVE</>
                : <><WifiOff size={10} />OFFLINE</>}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-lg mx-auto px-6 pt-6 pb-24">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === 'dashboard' && renderDashboard()}
            {activeTab === 'sale' && renderSaleForm()}
            {activeTab === 'reports' && renderReports()}
            {activeTab === 'settings' && renderSettings()}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Success Overlay */}
      <AnimatePresence>
        {showSuccess && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
          >
            <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl flex flex-col items-center gap-4 shadow-2xl">
              <div className="w-16 h-16 bg-emerald-600 rounded-full flex items-center justify-center text-white">
                <CheckCircle2 size={40} />
              </div>
              <div className="text-center">
                <h3 className="text-xl font-bold text-white">Venda Registrada!</h3>
                <p className="text-zinc-400 text-sm">O ingresso foi salvo com sucesso.</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Password Modal */}
      <AnimatePresence>
        {saleToDelete && (
          <PasswordModal
            onConfirm={handleConfirmDelete}
            onCancel={() => setSaleToDelete(null)}
          />
        )}
      </AnimatePresence>

      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className={cn(
              'fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-2xl text-sm font-medium shadow-xl whitespace-nowrap',
              toast.type === 'success'
                ? 'bg-emerald-600 text-white'
                : 'bg-red-700 text-white'
            )}
          >
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-black/80 backdrop-blur-lg border-t border-zinc-800/50 px-6 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <NavButton active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} icon={<LayoutDashboard size={20} />} label="Início" />
          <NavButton active={activeTab === 'reports'} onClick={() => setActiveTab('reports')} icon={<Activity size={20} />} label="Relatórios" />
          <NavButton active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} icon={<Settings size={20} />} label="Ajustes" />
        </div>
      </nav>
    </div>
  );
}

// ─── SaleFormContent ─────────────────────────────────────────────────────────

function SaleFormContent({
  defaultPrice,
  onAddSale,
  onCancel,
}: {
  defaultPrice: number;
  onAddSale: (n: string, p: PaymentMethod, v: number, pdf: boolean) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState(defaultPrice > 0 ? defaultPrice.toString() : '');
  const [payment, setPayment] = useState<PaymentMethod>('Pix');
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus no campo nome ao montar (abre teclado no mobile)
  useEffect(() => {
    const timer = setTimeout(() => {
      nameInputRef.current?.focus();
    }, 150); // pequeno delay para a animação de entrada terminar
    return () => clearTimeout(timer);
  }, []);

  const parsedValue = parseFloat(value);
  const isValid = name.trim().length > 0 && !isNaN(parsedValue) && parsedValue > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <button onClick={onCancel} className="p-2 bg-zinc-900 rounded-full text-zinc-400">
          <ArrowLeft size={20} />
        </button>
        <h2 className="text-xl font-bold text-white">Nova Venda</h2>
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-500 uppercase tracking-wider ml-1">
            Nome do Participante
          </label>
          <input
            ref={nameInputRef}
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Ex: João Silva"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-4 text-white focus:outline-none focus:border-emerald-500 transition-colors"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-500 uppercase tracking-wider ml-1">
            Valor do Ingresso (R$)
          </label>
          <input
            type="number"
            inputMode="decimal"
            value={value}
            onChange={e => setValue(e.target.value)}
            min="0.01"
            step="0.01"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-4 text-white text-2xl font-bold focus:outline-none focus:border-emerald-500 transition-colors"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-500 uppercase tracking-wider ml-1">
            Forma de Pagamento
          </label>
          <div className="grid grid-cols-3 gap-2">
            {(['Pix', 'Dinheiro', 'Cartão'] as PaymentMethod[]).map(m => (
              <button
                key={m}
                onClick={() => setPayment(m)}
                className={cn(
                  'py-4 rounded-xl border font-medium transition-all active:scale-95',
                  payment === m
                    ? 'bg-emerald-600/20 border-emerald-500 text-emerald-500'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-500'
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ID preview */}
      {name.trim() && (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl px-4 py-2.5">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-0.5">ID que será gerado</div>
          <div className="font-mono text-xs text-zinc-400">{generateSaleId(name)}</div>
        </div>
      )}

      <div className="pt-2 space-y-3">
        <button
          disabled={!isValid}
          onClick={() => onAddSale(name.trim(), payment, parsedValue, true)}
          className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-5 rounded-2xl flex items-center justify-center gap-3 shadow-lg shadow-emerald-900/20 transition-all active:scale-95"
        >
          <FileText size={20} />
          GERAR INGRESSO (PDF)
        </button>
        <button
          disabled={!isValid}
          onClick={() => onAddSale(name.trim(), payment, parsedValue, false)}
          className="w-full bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-3 transition-all active:scale-95"
        >
          REGISTRAR SEM PDF
        </button>
      </div>
    </div>
  );
}

// ─── NavButton ────────────────────────────────────────────────────────────────

function NavButton({ active, onClick, icon, label }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex flex-col items-center gap-1 transition-all',
        active ? 'text-emerald-500' : 'text-zinc-500 hover:text-zinc-300'
      )}
    >
      <div className={cn('p-1.5 rounded-xl transition-all', active && 'bg-emerald-500/10')}>
        {icon}
      </div>
      <span className="text-[10px] font-medium uppercase tracking-widest">{label}</span>
    </button>
  );
}

// ─── SwipeableSaleItem & PasswordModal ──────────────────────────────────────

function SwipeableSaleItem({ sale, hideFinancials, onDeleteIntent }: {
  key?: string;
  sale: Sale;
  hideFinancials: boolean;
  onDeleteIntent: (sale: Sale) => void;
}) {
  const x = useMotionValue(0);

  const handleDragEnd = (_e: any, info: any) => {
    // Se arrastou pra esquerda o suficiente
    if (info.offset.x < -60) {
      onDeleteIntent(sale);
    }
    // Volta sempre para a origem suavemente
    animate(x, 0, { type: 'spring', stiffness: 300, damping: 20 });
  };

  return (
    <div className="relative group overflow-hidden rounded-xl bg-zinc-900/50 border border-zinc-800/50">
      {/* Swipe background (Delete action) */}
      <div className="absolute inset-y-0 right-0 w-24 bg-red-600 flex items-center justify-end pr-5 rounded-r-xl">
        <Trash2 size={20} className="text-white" />
      </div>

      <motion.div
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={{ left: 0.2, right: 0 }}
        style={{ x }}
        onDragEnd={handleDragEnd}
        className="relative bg-zinc-900/95 flex items-center justify-between gap-2 p-3 rounded-xl touch-pan-y"
      >
        <div className="min-w-0">
          <div className="text-sm font-medium text-white truncate">{sale.participantName}</div>
          <div className="text-[10px] text-zinc-500">
            {format(parseISO(sale.timestamp), 'HH:mm:ss')} • {sale.paymentMethod}
            {!sale.synced && <span className="ml-1 text-amber-500">• pendente</span>}
          </div>
          <div className="text-[9px] font-mono text-zinc-600 mt-0.5 truncate flex items-center gap-1">
             {!sale.synced && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />}
             {sale.id}
          </div>
        </div>
        <div className="text-sm font-bold text-white flex-shrink-0">
          {hideFinancials ? '••••' : `R$ ${sale.value.toFixed(2)}`}
        </div>
      </motion.div>
    </div>
  );
}

function PasswordModal({ onConfirm, onCancel }: { onConfirm: (pwd: string) => void; onCancel: () => void }) {
  const [pwd, setPwd] = useState('');
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
    >
      <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-3xl w-full max-w-sm shadow-2xl">
        <div className="flex items-center gap-3 text-red-500 mb-4">
          <div className="p-3 bg-red-500/10 rounded-full">
            <Lock size={24} />
          </div>
          <h3 className="text-lg font-bold">Autorização</h3>
        </div>
        <p className="text-sm text-zinc-400 mb-6">
          Deslize detectado. Digite a senha de administrador (1515) para confirmar a exclusão.
        </p>
        <input
          type="number"
          inputMode="numeric"
          autoFocus
          value={pwd}
          onChange={e => setPwd(e.target.value)}
          placeholder="Senha"
          className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-red-500 mb-6"
          onKeyDown={e => e.key === 'Enter' && onConfirm(pwd)}
        />
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 py-3 bg-zinc-800 text-white rounded-xl font-medium transition-colors hover:bg-zinc-700">
            Cancelar
          </button>
          <button onClick={() => onConfirm(pwd)} className="flex-1 py-3 bg-red-600 text-white rounded-xl font-medium transition-colors hover:bg-red-500">
            Excluir
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ─── EmptyChart ───────────────────────────────────────────────────────────────

function EmptyChart() {
  return (
    <div className="h-48 flex flex-col items-center justify-center text-zinc-600 gap-2">
      <Activity size={24} />
      <span className="text-xs">Sem dados ainda</span>
    </div>
  );
}

// ─── BannerUploader ───────────────────────────────────────────────────────────

function BannerUploader({
  currentBanner,
  onBannerChange,
  onBannerRemove,
}: {
  currentBanner?: string;
  onBannerChange: (base64: string) => void;
  onBannerRemove: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setError(null);
    if (!file.type.startsWith('image/')) {
      setError('Arquivo inválido. Selecione uma imagem (JPG, PNG, WebP).');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('Imagem muito grande. Máximo 10MB.');
      return;
    }
    setIsProcessing(true);
    try {
      const compressed = await compressImage(file, 1500, 0.95);
      onBannerChange(compressed);
    } catch {
      setError('Erro ao processar a imagem.');
    } finally {
      setIsProcessing(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
      <div className="px-5 pt-4 pb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Banner do Evento</h3>
          <p className="text-[11px] text-zinc-500 mt-0.5">Aparece no cabeçalho do ingresso PDF</p>
        </div>
        {currentBanner && (
          <button
            onClick={onBannerRemove}
            className="text-xs text-red-500 hover:text-red-400 transition-colors px-2 py-1 rounded-lg hover:bg-red-900/20"
          >
            Remover
          </button>
        )}
      </div>

      {currentBanner ? (
        /* Preview do Banner */
        <div className="relative mx-4 mb-4 rounded-xl overflow-hidden group cursor-pointer"
          onClick={() => inputRef.current?.click()}>
          <img
            src={currentBanner}
            alt="Banner do evento"
            className="w-full h-36 object-cover"
          />
          {/* Overlay de troca */}
          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2">
            <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <span className="text-white text-xs font-medium">Trocar imagem</span>
          </div>
          {/* Badge de indicação */}
          <div className="absolute top-2 left-2 bg-emerald-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">
            Ativo
          </div>
        </div>
      ) : (
        /* Drop Zone */
        <div
          className={cn(
            'mx-4 mb-4 border-2 border-dashed rounded-xl transition-all cursor-pointer',
            isDragging
              ? 'border-emerald-500 bg-emerald-500/10'
              : 'border-zinc-700 hover:border-zinc-500 bg-zinc-950/50',
            isProcessing && 'opacity-60 pointer-events-none'
          )}
          onClick={() => inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
        >
          <div className="py-8 flex flex-col items-center gap-3 text-center px-4">
            {isProcessing ? (
              <>
                <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-zinc-400">Processando imagem...</span>
              </>
            ) : (
              <>
                <div className={cn(
                  'w-12 h-12 rounded-2xl flex items-center justify-center transition-colors',
                  isDragging ? 'bg-emerald-500/20' : 'bg-zinc-800'
                )}>
                  <svg
                    className={cn('w-6 h-6', isDragging ? 'text-emerald-400' : 'text-zinc-500')}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm text-zinc-300 font-medium">
                    {isDragging ? 'Solte aqui' : 'Arraste ou clique para enviar'}
                  </p>
                  <p className="text-[11px] text-zinc-600 mt-1">JPG, PNG, WebP · Máx. 10MB</p>
                  <p className="text-[10px] text-zinc-700 mt-0.5">Recomendado: proporção 16:9 ou 3:1</p>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="mx-4 mb-4 flex items-center gap-2 text-xs text-red-400 bg-red-900/20 border border-red-900/40 rounded-xl px-3 py-2">
          <AlertCircle size={12} className="flex-shrink-0" />
          {error}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
