const LOW_STOCK_THRESHOLD = 5;
const PLAN_CONFIG = {
  basic: {
    id: "basic",
    name: "BizTrack Basic",
    priceLabel: "UGX 5,000 / month",
    pages: ["businesses", "dashboard", "accounting", "overall"],
    includes: [
      "Businesses",
      "Dashboard (accounting figures only)",
      "Accounting",
      "Overall Profit & Loss",
    ],
  },
  pro: {
    id: "pro",
    name: "BizTrack Pro",
    priceLabel: "UGX 7,500 / month",
    pages: [
      "businesses",
      "dashboard",
      "accounting",
      "inventory",
      "sales",
      "overall",
    ],
    includes: [
      "Everything in Basic",
      "Sales & Invoicing",
      "Inventory",
      "Dashboard sales/inventory widgets",
    ],
  },
  premium: {
    id: "premium",
    name: "BizTrack Premium",
    priceLabel: "UGX 12,000 / month",
    pages: [
      "businesses",
      "dashboard",
      "accounting",
      "inventory",
      "sales",
      "overall",
      "news",
    ],
    includes: ["Everything in Pro", "News section", "All existing features"],
  },
};
const fmt = (n) => "UGX " + Math.round(Number(n || 0)).toLocaleString();
const uiText = (value) => value;
const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
const toNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};
const toFiniteNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};
let currentBusinessId = "";
let businesses = [];
let contextBusinessId = "";
const supabaseConfig = window.BIZTRACK_SUPABASE_CONFIG || {};
const hasSupabaseConfig =
  /^https:\/\/[^/]+\.supabase\.co$/.test(supabaseConfig.url || "") &&
  Boolean(supabaseConfig.anonKey) &&
  !supabaseConfig.anonKey.includes("YOUR_");
const supabaseClient =
  hasSupabaseConfig && window.supabase?.createClient
    ? window.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey)
    : null;
let activeUser = null;
let activePlan = "";
const emptyStore = () => ({
  businesses: [],
  products: [],
  customers: [],
  transactions: [],
  invoices: [],
  stockMovements: [],
  marketPrices: [],
});
const getBusinessStorageKey = (accountId) =>
  accountId ? `biztrack-business-${accountId}` : "biztrack-business-id";
const formatLocalDate = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
};
const bytesToBase64 = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));
const base64ToBytes = (value) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const deriveKey = async (password, salt) => {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );
  const saltBytes = base64ToBytes(salt);
  const verifier = bytesToBase64(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: saltBytes, iterations: 310000, hash: "SHA-256" },
      material,
      256,
    ),
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: 310000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { key, verifier };
};
const encryptStore = async (store) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    activeUser.key,
    new TextEncoder().encode(JSON.stringify(store)),
  );
  return JSON.stringify({
    iv: bytesToBase64(iv),
    data: bytesToBase64(encrypted),
  });
};
const readStore = async () => {
  if (!supabaseClient || !activeUser)
    throw new Error("Your session has expired.");
  const { data: workspace, error } = await supabaseClient
    .from("biztrack_workspaces")
    .select("encrypted_data, updated_at")
    .eq("user_id", activeUser.id)
    .maybeSingle();
  if (error) throw new Error("Your workspace could not be loaded.");
  if (!workspace?.encrypted_data) return emptyStore();
  try {
    const payload = JSON.parse(workspace.encrypted_data);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
      activeUser.key,
      base64ToBytes(payload.data),
    );
    const parsed = JSON.parse(new TextDecoder().decode(decrypted));
    activeUser.workspaceUpdatedAt = workspace.updated_at || null;
    return {
      ...emptyStore(),
      ...parsed,
    };
  } catch {
    throw new Error("Your private data could not be unlocked.");
  }
};
const writeStore = async (store, options = {}) => {
  if (!supabaseClient || !activeUser)
    throw new Error("Your session has expired.");
  const encryptedData = await encryptStore(store);
  const payload = {
    user_id: activeUser.id,
    salt: activeUser.salt,
    encrypted_data: encryptedData,
    updated_at: new Date().toISOString(),
  };
  const expectedUpdatedAt =
    activeUser.workspaceUpdatedAt || options.expectedUpdatedAt;
  let result;
  if (expectedUpdatedAt) {
    result = await supabaseClient
      .from("biztrack_workspaces")
      .update(payload)
      .eq("user_id", activeUser.id)
      .eq("updated_at", expectedUpdatedAt);
  } else {
    result = await supabaseClient
      .from("biztrack_workspaces")
      .upsert(payload, { onConflict: "user_id" });
  }
  const { error, count } = result || {};
  if (error) throw new Error("Your workspace could not be saved.");
  if ((typeof count === "number" && count === 0) || (result && !result.data)) {
    const latest = await supabaseClient
      .from("biztrack_workspaces")
      .select("encrypted_data, updated_at")
      .eq("user_id", activeUser.id)
      .maybeSingle();
    if (latest?.data) {
      activeUser.workspaceUpdatedAt = latest.data.updated_at;
      throw new Error(
        "Your data was changed on another device — reloaded the latest version.",
      );
    }
    throw new Error("Your workspace could not be saved.");
  }
  activeUser.workspaceUpdatedAt = payload.updated_at;
};
const saveProfile = async ({ id, email, name }) => {
  if (!supabaseClient) throw new Error("Supabase is not configured.");
  const { error } = await supabaseClient.from("biztrack_profiles").upsert(
    {
      user_id: id,
      email,
      name: String(name || "").trim(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
};
const updateSubscription = async (plan, paymentMethod = null) => {
  if (!supabaseClient || !activeUser)
    throw new Error("Your session has expired.");
  const { error } = await supabaseClient
    .from("biztrack_profiles")
    .update({
      subscription_plan: plan,
      payment_method: paymentMethod,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", activeUser.id);
  if (error) throw error;
  activePlan = plan;
  const planName = PLAN_CONFIG[plan]?.name || "Basic";
  document.getElementById("account-plan").textContent = planName;
};
const planAllowed = (page) => {
  const plan = activePlan || "basic";
  const current = PLAN_CONFIG[plan]?.pages || PLAN_CONFIG.basic.pages;
  return current.includes(page);
};
const ensurePlanAccess = (tab) => {
  if (tab === "news" && !planAllowed("news")) return false;
  if (tab === "sales" && !planAllowed("sales")) return false;
  if (tab === "inventory" && !planAllowed("inventory")) return false;
  if (tab === "dashboard" && !planAllowed("dashboard")) return false;
  return true;
};
const nextId = (rows) =>
  Math.max(0, ...rows.map((row) => Number(row.id) || 0)) + 1;
const requestData = (opts) => (opts?.body ? JSON.parse(opts.body) : {});
const requireBusiness = () => {
  if (!currentBusinessId) throw new Error("Select a business first.");
  return Number(currentBusinessId);
};
const reportRange = (params) => {
  const period = params.get("period") || "monthly";
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  if (period === "daily") end.setDate(end.getDate() + 1);
  else if (period === "weekly") {
    start.setDate(start.getDate() - 6);
    end.setDate(end.getDate() + 1);
  } else if (period === "custom") {
    const startValue = params.get("start");
    const endValue = params.get("end");
    const customStart = new Date(`${startValue}T00:00:00`);
    const customEnd = new Date(`${endValue}T00:00:00`);
    customEnd.setDate(customEnd.getDate() + 1);
    return {
      start: customStart,
      end: customEnd,
      label: `Custom dates: ${startValue} to ${endValue}`,
    };
  } else {
    start.setDate(start.getDate() - 29);
    end.setDate(end.getDate() + 1);
  }
  return {
    start,
    end,
    label:
      period === "daily"
        ? "Today"
        : period === "weekly"
          ? "Last 7 days"
          : "Last 30 days",
  };
};
const inRange = (value, range) => {
  const date = new Date(value);
  return date >= range.start && date < range.end;
};
const groupedTotals = (rows) =>
  Object.values(
    rows.reduce((result, row) => {
      result[row.category] = result[row.category] || {
        category: row.category,
        total: 0,
      };
      result[row.category].total += Number(row.amount);
      return result;
    }, {}),
  ).sort((a, b) => b.total - a.total);
const api = async (path, opts = {}) => {
  const [route, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  const method = (opts.method || "GET").toUpperCase();
  const data = requestData(opts);
  const store = await readStore();
  const businessId = Number(currentBusinessId);
  const scoped = (rows) =>
    rows.filter((row) => Number(row.business_id) === businessId);
  const save = async () => writeStore(store);
  if (route === "/businesses") {
    if (method === "GET")
      return store.businesses
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
    const name = String(data.name || "").trim();
    if (!name) throw new Error("Business name is required.");
    if (
      store.businesses.some(
        (business) => business.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new Error("A business with that name already exists.");
    const business = {
      id: nextId(store.businesses),
      name,
      business_type: String(data.business_type || "").trim(),
      created_at: new Date().toISOString(),
    };
    store.businesses.push(business);
    await save();
    return { ok: true, business };
  }
  const businessMatch = route.match(/^\/businesses\/(\d+)$/);
  if (businessMatch) {
    const id = Number(businessMatch[1]);
    const business = store.businesses.find((row) => row.id === id);
    if (!business) throw new Error("Business not found.");
    if (method === "PATCH") {
      const name = String(data.name || "").trim();
      if (!name) throw new Error("Business name is required.");
      if (
        store.businesses.some(
          (row) =>
            row.id !== id && row.name.toLowerCase() === name.toLowerCase(),
        )
      )
        throw new Error("A business with that name already exists.");
      business.name = name;
      await save();
      return { ok: true, business };
    }
    if (method === "DELETE") {
      [
        "products",
        "customers",
        "transactions",
        "invoices",
        "stockMovements",
        "marketPrices",
      ].forEach((key) => {
        store[key] = store[key].filter((row) => Number(row.business_id) !== id);
      });
      store.businesses = store.businesses.filter((row) => row.id !== id);
      await save();
      return { ok: true };
    }
  }
  if (route === "/overall-profit-loss") {
    const businesses = store.businesses.map((business) => {
      const rows = store.transactions.filter(
        (row) => row.business_id === business.id,
      );
      const income = rows
        .filter((row) => row.type === "income")
        .reduce((sum, row) => sum + Number(row.amount), 0);
      const expenses = rows
        .filter((row) => row.type === "expense")
        .reduce((sum, row) => sum + Number(row.amount), 0);
      return { ...business, income, expenses, net_profit: income - expenses };
    });
    const total_income = businesses.reduce((sum, row) => sum + row.income, 0);
    const total_expenses = businesses.reduce(
      (sum, row) => sum + row.expenses,
      0,
    );
    return {
      businesses,
      total_income,
      total_expenses,
      net_profit: total_income - total_expenses,
    };
  }
  const id = requireBusiness();
  const range = reportRange(params);
  if (route === "/transactions") {
    if (method === "POST") {
      const amount = Number(data.amount);
      const category = String(data.category || "").trim();
      if (!category || !Number.isFinite(amount) || amount <= 0)
        throw new Error("Add a category and an amount greater than zero.");
      const dateValue = data.occurred_at
        ? new Date(`${data.occurred_at}T12:00:00`)
        : new Date();
      const transaction = {
        id: nextId(store.transactions),
        business_id: id,
        type: data.type,
        category,
        description: String(data.description || "").trim(),
        amount,
        occurred_at: Number.isNaN(dateValue.getTime())
          ? new Date().toISOString()
          : dateValue.toISOString(),
      };
      store.transactions.push(transaction);
      await save();
      return { ok: true, transaction };
    }
    return scoped(store.transactions)
      .filter((row) => inRange(row.occurred_at, range))
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  }
  if (route === "/profit-loss") {
    const rows = scoped(store.transactions).filter((row) =>
      inRange(row.occurred_at, range),
    );
    const income_by_category = groupedTotals(
      rows.filter((row) => row.type === "income"),
    );
    const expense_by_category = groupedTotals(
      rows.filter((row) => row.type === "expense"),
    );
    const total_income = income_by_category.reduce(
      (sum, row) => sum + row.total,
      0,
    );
    const total_expense = expense_by_category.reduce(
      (sum, row) => sum + row.total,
      0,
    );
    return {
      period_label: range.label,
      income_by_category,
      expense_by_category,
      total_income,
      total_expense,
      net_profit: total_income - total_expense,
    };
  }
  if (route === "/products") {
    if (method === "POST") {
      const name = String(data.name || "").trim();
      const stockQty = Number(data.stock_qty);
      const costPrice = Number(data.cost_price);
      const sellPrice = Number(data.sell_price);
      if (!name) throw new Error("Product name is required.");
      if (!Number.isFinite(stockQty) || stockQty < 0)
        throw new Error(
          "Stock quantity must be a valid number greater than or equal to zero.",
        );
      if (!Number.isFinite(costPrice) || costPrice < 0)
        throw new Error(
          "Cost price must be a valid number greater than or equal to zero.",
        );
      if (!Number.isFinite(sellPrice) || sellPrice < 0)
        throw new Error(
          "Sell price must be a valid number greater than or equal to zero.",
        );
      const product = {
        id: nextId(store.products),
        business_id: id,
        name,
        category: String(data.category || "").trim(),
        unit: String(data.unit || "unit").trim() || "unit",
        stock_qty: stockQty,
        reorder_level: toNumber(data.reorder_level, 0),
        cost_price: costPrice,
        sell_price: sellPrice,
      };
      store.products.push(product);
      if (product.stock_qty)
        store.stockMovements.push({
          id: nextId(store.stockMovements),
          business_id: id,
          product_id: product.id,
          change_qty: product.stock_qty,
          occurred_at: new Date().toISOString(),
        });
      await save();
      return { ok: true };
    }
    return scoped(store.products).sort((a, b) => a.name.localeCompare(b.name));
  }
  const stockMatch = route.match(/^\/products\/(\d+)\/stock$/);
  if (stockMatch) {
    const product = store.products.find(
      (row) => row.id === Number(stockMatch[1]) && row.business_id === id,
    );
    if (!product) throw new Error("Product not found.");
    const delta = Number(data.delta);
    if (!Number.isFinite(delta) || delta === 0)
      throw new Error("Stock adjustment must be a non-zero number.");
    const nextStock = Number(product.stock_qty) + delta;
    if (!Number.isFinite(nextStock))
      throw new Error("Stock adjustment would create an invalid stock value.");
    product.stock_qty = nextStock;
    store.stockMovements.push({
      id: nextId(store.stockMovements),
      business_id: id,
      product_id: product.id,
      change_qty: delta,
      occurred_at: new Date().toISOString(),
    });
    await save();
    return { ok: true };
  }
  if (route === "/customers")
    return scoped(store.customers).sort((a, b) => a.name.localeCompare(b.name));
  if (route === "/market-prices") {
    if (method === "POST") {
      store.marketPrices.push({
        id: nextId(store.marketPrices),
        business_id: id,
        product_id: Number(data.product_id),
        supplier_name: String(data.supplier_name || "Manual entry"),
        supplier_price: Number(data.supplier_price),
        market_price: Number(data.market_price),
        recorded_at: new Date().toISOString(),
      });
      await save();
      return { ok: true };
    }
    return scoped(store.products)
      .map((product) => {
        const history = scoped(store.marketPrices)
          .filter((row) => row.product_id === product.id)
          .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
        if (!history.length) return null;
        const latest = history.at(-1);
        return {
          product_id: product.id,
          product_name: product.name,
          your_cost_price: product.cost_price,
          your_sell_price: product.sell_price,
          latest_supplier_price: latest.supplier_price,
          latest_market_price: latest.market_price,
          latest_supplier_name: latest.supplier_name,
          suggested_sell_price:
            Math.round((latest.market_price * 0.97) / 100) * 100,
          margin_vs_market_pct: 0,
          history,
        };
      })
      .filter(Boolean);
  }
  if (route === "/invoices") {
    if (method === "POST") {
      const customerName = String(
        data.customer_name || data.customer_text || "",
      ).trim();
      if (!customerName) throw new Error("Provide a customer name.");
      let customer = scoped(store.customers).find(
        (row) => row.name.toLowerCase() === customerName.toLowerCase(),
      );
      if (!customer) {
        customer = {
          id: nextId(store.customers),
          business_id: id,
          name: customerName,
        };
        store.customers.push(customer);
      }
      const productName = String(data.product_name || "").trim();
      if (!productName) throw new Error("Provide a product name.");
      let product = scoped(store.products).find(
        (row) => row.name.toLowerCase() === productName.toLowerCase(),
      );
      const qty = Number(data.qty);
      const unitPrice = Number(data.unit_price);
      if (!Number.isFinite(qty) || qty <= 0)
        throw new Error(
          "Invoice qty must be a finite number greater than zero.",
        );
      if (!Number.isFinite(unitPrice) || unitPrice < 0)
        throw new Error(
          "Invoice unit price must be a valid number greater than or equal to zero.",
        );
      const invoiceDate = data.occurred_at
        ? new Date(`${data.occurred_at}T12:00:00`)
        : new Date();
      const invoice = {
        id: nextId(store.invoices),
        business_id: id,
        customer_id: customer.id,
        product_id: product ? product.id : null,
        product_name: productName,
        qty,
        unit_price: unitPrice,
        status: data.status || "unpaid",
        created_at: Number.isNaN(invoiceDate.getTime())
          ? new Date().toISOString()
          : invoiceDate.toISOString(),
      };
      if (product) {
        if (qty > product.stock_qty)
          throw new Error("This invoice would oversell the available stock.");
        product.stock_qty -= qty;
      }
      store.invoices.push(invoice);
      if (product) {
        store.stockMovements.push({
          id: nextId(store.stockMovements),
          business_id: id,
          product_id: product.id,
          change_qty: -qty,
          occurred_at: invoice.created_at,
        });
      }
      if (invoice.status === "paid")
        store.transactions.push({
          id: nextId(store.transactions),
          business_id: id,
          type: "income",
          category: "Sales",
          description: `Invoice sale (${productName})`,
          amount: qty * unitPrice,
          occurred_at: invoice.created_at,
        });
      await save();
      return { ok: true };
    }
    return scoped(store.invoices)
      .map((invoice) => ({
        ...invoice,
        customer_name:
          store.customers.find((row) => row.id === invoice.customer_id)?.name ||
          "Customer",
        product_name:
          invoice.product_name ||
          store.products.find((row) => row.id === invoice.product_id)?.name ||
          "Product",
        total: invoice.qty * invoice.unit_price,
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  const paidMatch = route.match(/^\/invoices\/(\d+)\/mark-paid$/);
  if (paidMatch) {
    const invoice = scoped(store.invoices).find(
      (row) => row.id === Number(paidMatch[1]),
    );
    if (!invoice) throw new Error("Invoice not found.");
    if (invoice.status !== "paid") {
      invoice.status = "paid";
      store.transactions.push({
        id: nextId(store.transactions),
        business_id: id,
        type: "income",
        category: "Sales",
        description: "Invoice payment",
        amount: invoice.qty * invoice.unit_price,
        occurred_at: new Date().toISOString(),
      });
      await save();
    }
    return { ok: true };
  }
  if (route === "/dashboard") {
    const transactions = scoped(store.transactions).filter((row) =>
      inRange(row.occurred_at, range),
    );
    const invoices = scoped(store.invoices).filter((row) =>
      inRange(row.created_at, range),
    );
    const income = transactions
      .filter((row) => row.type === "income")
      .reduce((sum, row) => sum + Number(row.amount), 0);
    const expenses = transactions
      .filter((row) => row.type === "expense")
      .reduce((sum, row) => sum + Number(row.amount), 0);
    const products = scoped(store.products);
    const movements = scoped(store.stockMovements).filter((row) =>
      inRange(row.occurred_at, range),
    );
    const top = Object.values(
      invoices.reduce((result, invoice) => {
        const product = products.find((row) => row.id === invoice.product_id);
        const item = result[invoice.product_id] || {
          name: product?.name || "Product",
          qty_sold: 0,
          revenue: 0,
        };
        item.qty_sold += invoice.qty;
        item.revenue += invoice.qty * invoice.unit_price;
        result[invoice.product_id] = item;
        return result;
      }, {}),
    )
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
    return {
      period_label: range.label,
      today_sales: income,
      today_expenses: expenses,
      sales_total: invoices.reduce(
        (sum, row) => sum + row.qty * row.unit_price,
        0,
      ),
      sales_units: invoices.reduce((sum, row) => sum + row.qty, 0),
      stock_in: movements
        .filter((row) => row.change_qty > 0)
        .reduce((sum, row) => sum + row.change_qty, 0),
      stock_out: -movements
        .filter((row) => row.change_qty < 0)
        .reduce((sum, row) => sum + row.change_qty, 0),
      inventory_value: products.reduce(
        (sum, row) => sum + row.stock_qty * row.cost_price,
        0,
      ),
      net_profit_30d: income - expenses,
      revenue_30d: income,
      expenses_30d: expenses,
      low_stock: products.filter((row) => row.stock_qty <= row.reorder_level),
      top_products: top,
      outstanding_invoices: scoped(store.invoices)
        .filter((row) => row.status === "unpaid")
        .reduce((sum, row) => sum + row.qty * row.unit_price, 0),
    };
  }
  throw new Error("This offline action is not available.");
};
const showToast = (message, isError = false) => {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = "toast show" + (isError ? " error" : "");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (toast.className = "toast"), 3200);
};
let activePeriod = "monthly";
const isoDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const reportQuery = () => {
  const params = new URLSearchParams({ period: activePeriod });
  if (activePeriod === "custom") {
    params.set("start", document.getElementById("report-start").value);
    params.set("end", document.getElementById("report-end").value);
  }
  return `?${params.toString()}`;
};
const setDefaultDateInputs = () => {
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  document.querySelectorAll('input[name="occurred_at"]').forEach((input) => {
    if (!input.value) input.value = iso;
  });
};
const reloadReports = () =>
  Promise.all([loadDashboard(), loadAccounting()]).catch((error) =>
    showToast(error.message, true),
  );

const periodSelect = document.getElementById("report-period");
const customRange = document.getElementById("custom-date-range");
const customPeriodToggle = document.getElementById("custom-period-toggle");
const today = new Date();
setDefaultDateInputs();
document.getElementById("report-end").value = isoDate(today);
document.getElementById("report-start").value = isoDate(
  new Date(today.getTime() - 29 * 86400000),
);
periodSelect.addEventListener("change", () => {
  activePeriod = periodSelect.value;
  customRange.classList.toggle("hidden", activePeriod !== "custom");
  customRange.classList.remove("mobile-custom-open");
  if (activePeriod !== "custom") reloadReports();
  else document.getElementById("report-start").focus();
});
customPeriodToggle.addEventListener("click", () => {
  activePeriod = "custom";
  periodSelect.value = "custom";
  customRange.classList.remove("hidden");
  customRange.classList.toggle(
    "mobile-custom-open",
    !customRange.classList.contains("mobile-custom-open"),
  );
});
document.getElementById("apply-custom-period").addEventListener("click", () => {
  const start = document.getElementById("report-start").value;
  const end = document.getElementById("report-end").value;
  if (!start || !end || end < start) {
    showToast("Choose a start date that comes before the end date.", true);
    return;
  }
  customRange.classList.remove("mobile-custom-open");
  reloadReports();
});

// ---- Businesses ----
const mobileMenuButton = document.querySelector(".mobile-menu-btn");
const sidebar = document.querySelector(".sidebar");
const closeMobileMenu = () => {
  if (sidebar) sidebar.classList.remove("open");
};
const openMobileMenu = () => {
  if (sidebar) sidebar.classList.add("open");
};
const activateTab = (tab) => {
  if (!ensurePlanAccess(tab)) {
    const planName = PLAN_CONFIG[activePlan]?.name || "BizTrack Basic";
    showToast(`Available on ${planName} — Try for free`, true);
    const fallback =
      Object.keys(PLAN_CONFIG).find((key) =>
        PLAN_CONFIG[key].pages.includes(tab),
      ) || "businesses";
    tab = fallback;
  }
  document
    .querySelectorAll(".nav-item")
    .forEach((item) =>
      item.classList.toggle("active", item.dataset.tab === tab),
    );
  document
    .querySelectorAll(".tab")
    .forEach((item) => item.classList.add("hidden"));
  const target = document.getElementById(`tab-${tab}`);
  if (target) target.classList.remove("hidden");
  if (window.innerWidth <= 900) closeMobileMenu();
  if (tab === "overall") loadOverallProfitLoss();
  if (["dashboard", "accounting", "inventory", "sales", "news"].includes(tab))
    loadTab(tab);
};
if (mobileMenuButton) {
  mobileMenuButton.addEventListener("click", () => {
    if (sidebar?.classList.contains("open")) closeMobileMenu();
    else openMobileMenu();
  });
}
document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => activateTab(item.dataset.tab));
});
document.addEventListener("click", (event) => {
  if (window.innerWidth > 900 || !sidebar || !mobileMenuButton) return;
  const clickedMenu =
    sidebar.contains(event.target) || mobileMenuButton.contains(event.target);
  if (!clickedMenu) closeMobileMenu();
});
const renderBusinesses = () => {
  const select = document.getElementById("business-select");
  select.innerHTML =
    '<option value="">Select a business</option>' +
    businesses
      .map(
        (business) =>
          `<option value="${business.id}">${escapeHtml(business.name)}</option>`,
      )
      .join("");
  select.value = currentBusinessId;
  document.getElementById("business-list").innerHTML = businesses.length
    ? businesses
        .map(
          (business) =>
            `<button class="business-row${String(business.id) === String(currentBusinessId) ? " selected" : ""}" data-business-id="${business.id}"><strong>${escapeHtml(business.name)}</strong><span>${escapeHtml(business.business_type || "Business")}</span></button>`,
        )
        .join("")
    : '<div class="empty">Add your first business to get started.</div>';
  document.querySelectorAll(".business-row").forEach((button) => {
    button.addEventListener("click", () =>
      selectBusiness(button.dataset.businessId),
    );
    button.addEventListener("contextmenu", (event) =>
      showBusinessMenu(event, button.dataset.businessId),
    );
  });
};
const selectBusiness = (id) => {
  currentBusinessId = String(id);
  if (activeUser?.id) {
    localStorage.setItem(
      getBusinessStorageKey(activeUser.id),
      currentBusinessId,
    );
    localStorage.removeItem("biztrack-business-id");
  } else {
    localStorage.setItem("biztrack-business-id", currentBusinessId);
  }
  const business = businesses.find(
    (item) => String(item.id) === currentBusinessId,
  );
  renderBusinesses();
  showToast(
    `${business?.name || "Business"} selected. Choose a section from the menu.`,
  );
};
const loadBusinesses = async () => {
  businesses = await api("/businesses");
  if (
    !businesses.some(
      (business) => String(business.id) === String(currentBusinessId),
    )
  )
    currentBusinessId = "";
  renderBusinesses();
};
document
  .getElementById("business-select")
  .addEventListener("change", (event) => {
    if (event.target.value) selectBusiness(event.target.value);
  });
const contextMenu = document.getElementById("business-context-menu");
const renameDialog = document.getElementById("rename-business-dialog");
const renameForm = document.getElementById("rename-business-form");
const renameInput = document.getElementById("rename-business-name");
const hideBusinessMenu = () => contextMenu.classList.add("hidden");
const closeRenameDialog = () => renameDialog.classList.add("hidden");
const showBusinessMenu = (event, businessId) => {
  event.preventDefault();
  contextBusinessId = businessId;
  contextMenu.style.left = `${event.clientX}px`;
  contextMenu.style.top = `${event.clientY}px`;
  contextMenu.classList.remove("hidden");
};
document.addEventListener("click", hideBusinessMenu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideBusinessMenu();
    closeRenameDialog();
  }
});
contextMenu.addEventListener("click", async (event) => {
  const action = event.target.dataset.action;
  if (!action || !contextBusinessId) return;
  event.stopPropagation();
  const business = businesses.find(
    (item) => String(item.id) === String(contextBusinessId),
  );
  hideBusinessMenu();
  if (action === "rename") {
    renameInput.value = business?.name || "";
    renameDialog.classList.remove("hidden");
    renameInput.focus();
    return;
  }
  if (action === "delete") {
    if (
      !window.confirm(
        `Delete ${business?.name || "this business"} and all of its records? This cannot be undone.`,
      )
    )
      return;
    try {
      await api(`/businesses/${contextBusinessId}`, { method: "DELETE" });
      if (String(currentBusinessId) === String(contextBusinessId)) {
        currentBusinessId = "";
        if (activeUser?.id)
          localStorage.removeItem(getBusinessStorageKey(activeUser.id));
        localStorage.removeItem("biztrack-business-id");
      }
      await loadBusinesses();
      activateTab("businesses");
      showToast("Business deleted.");
    } catch (error) {
      showToast(error.message, true);
    }
  }
});
document
  .getElementById("rename-business-cancel")
  .addEventListener("click", closeRenameDialog);
renameDialog.addEventListener("click", (event) => {
  if (event.target === renameDialog) closeRenameDialog();
});
renameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = renameInput.value.trim();
  if (!name) return;
  try {
    await api(`/businesses/${contextBusinessId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await loadBusinesses();
    closeRenameDialog();
    showToast("Business renamed.");
  } catch (error) {
    showToast(error.message, true);
  }
});
document
  .getElementById("business-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const business = await api("/businesses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(form)),
    });
    await loadBusinesses();
    event.currentTarget.reset();
    selectBusiness(business.business.id);
    showToast("Business added.");
  });
const authMessage = (message = "") => {
  document.getElementById("auth-message").textContent = message;
};
const showAuthPanel = (signup) => {
  document.getElementById("login-panel").classList.toggle("hidden", signup);
  document.getElementById("signup-panel").classList.toggle("hidden", !signup);
  authMessage();
};
const beginSession = async (account, key) => {
  activeUser = { id: account.id, key, salt: account.salt };
  activePlan = account.plan || "";
  const businessKey = getBusinessStorageKey(account.id);
  currentBusinessId =
    localStorage.getItem(businessKey) ||
    localStorage.getItem("biztrack-business-id") ||
    "";
  if (currentBusinessId) localStorage.setItem(businessKey, currentBusinessId);
  localStorage.removeItem("biztrack-business-id");
  document.getElementById("auth-screen").classList.add("hidden");
  if (activePlan) {
    document.getElementById("plan-screen").classList.add("hidden");
    document.querySelector(".app").classList.remove("hidden");
    document.getElementById("account-plan").textContent =
      PLAN_CONFIG[activePlan]?.name || "BizTrack Basic";
    updatePlanUI();
    await loadBusinesses();
  } else {
    document.querySelector(".app").classList.add("hidden");
    document.getElementById("plan-screen").classList.remove("hidden");
    showPlanSelection();
  }
};
const showPlanSelection = () => {
  if (!document.getElementById("plan-screen")) return;
  const cards = document.querySelectorAll("[data-plan-card]");
  cards.forEach((card) => {
    const code = card.dataset.planCard;
    card.classList.toggle("selected", activePlan === code);
  });
};
const updatePlanUI = () => {
  document.querySelectorAll("[data-plan-card]").forEach((card) => {
    card.classList.toggle("selected", activePlan === card.dataset.planCard);
  });
  document.querySelectorAll(".nav-item").forEach((item) => {
    const allowed =
      !item.dataset.tab ||
      item.dataset.tab === "businesses" ||
      planAllowed(item.dataset.tab);
    item.style.display = allowed ? "" : "none";
  });
};
const showAuthError = (error, fallback) => {
  if (error?.message === "Supabase is not configured.") {
    authMessage(
      "Supabase is not configured. Add your project URL and anon key in static/supabase-config.js.",
    );
    return;
  }
  authMessage(error?.message || fallback);
};
document
  .getElementById("show-signup")
  .addEventListener("click", () => showAuthPanel(true));
document
  .getElementById("show-login")
  .addEventListener("click", () => showAuthPanel(false));
document.querySelectorAll("[data-password-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = button.previousElementSibling;
    const isVisible = input.type === "text";
    input.type = isVisible ? "password" : "text";
    button.textContent = isVisible ? "Show" : "Hide";
    button.setAttribute(
      "aria-label",
      isVisible ? "Show password" : "Hide password",
    );
  });
});
document
  .getElementById("signup-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const email = String(values.email).trim().toLowerCase();
    const password = String(values.password);
    if (!email || password.length < 10)
      return authMessage(
        "Use a valid email and a password with at least 10 characters.",
      );
    try {
      if (!supabaseClient) throw new Error("Supabase is not configured.");
      const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
      const { key } = await deriveKey(password, salt);
      const { data, error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/`,
          data: { name: String(values.name).trim(), salt },
        },
      });
      if (error) throw error;
      if (!data.user || !data.session)
        return authMessage(
          "Account created, but email confirmation is enabled. Disable Confirm email in Supabase Authentication settings, then create the account again.",
        );
      const account = { id: data.user.id, email, salt };
      await saveProfile({
        id: data.user.id,
        email,
        name: values.name,
      });
      await beginSession(account, key);
      await writeStore(emptyStore());
    } catch (error) {
      showAuthError(error, "Could not create your account.");
    }
  });
document
  .getElementById("login-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      if (!supabaseClient) throw new Error("Supabase is not configured.");
      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: String(values.email).trim().toLowerCase(),
        password: String(values.password),
      });
      if (error) throw error;
      if (!data.user) throw new Error("Your account could not be found.");
      const { data: workspace, error: workspaceError } = await supabaseClient
        .from("biztrack_workspaces")
        .select("salt")
        .eq("user_id", data.user.id)
        .maybeSingle();
      if (workspaceError) throw workspaceError;
      const salt = workspace?.salt || data.user.user_metadata?.salt;
      if (!salt) throw new Error("Workspace encryption settings are missing.");
      const { key } = await deriveKey(String(values.password), salt);
      const { data: profile, error: profileError } = await supabaseClient
        .from("biztrack_profiles")
        .select("subscription_plan")
        .eq("user_id", data.user.id)
        .maybeSingle();
      if (profileError) throw profileError;
      const account = {
        id: data.user.id,
        email: data.user.email,
        salt,
        plan: profile?.subscription_plan || "",
      };
      await saveProfile({
        id: data.user.id,
        email: data.user.email,
        name: data.user.user_metadata?.name,
      });
      await beginSession(account, key);
      if (!workspace) await writeStore(emptyStore());
    } catch (error) {
      showAuthError(
        error,
        "Incorrect email or password, or private data could not be unlocked.",
      );
    }
  });

document.querySelectorAll(".plan-choice").forEach((button) => {
  button.addEventListener("click", async () => {
    const plan = button.dataset.plan;
    try {
      await updateSubscription(plan);
      document.getElementById("plan-screen").classList.add("hidden");
      document.querySelector(".app").classList.remove("hidden");
      updatePlanUI();
      await loadBusinesses();
      showToast(
        `${PLAN_CONFIG[plan]?.name || plan} selected. Welcome to BizTrack.`,
      );
    } catch (error) {
      document.getElementById("plan-message").textContent = error.message;
    }
  });
});
document
  .getElementById("change-plan-link")
  ?.addEventListener("click", (event) => {
    event.preventDefault();
    if (supabaseClient && activeUser) {
      document.querySelector(".app").classList.add("hidden");
      document.getElementById("plan-screen").classList.remove("hidden");
      showPlanSelection();
    }
  });
document.getElementById("logout-button").addEventListener("click", async () => {
  try {
    if (supabaseClient) await supabaseClient.auth.signOut();
  } finally {
    activeUser = null;
    activePlan = "";
    currentBusinessId = "";
    document.querySelector(".app").classList.add("hidden");
    document.getElementById("plan-screen").classList.add("hidden");
    document.getElementById("auth-screen").classList.remove("hidden");
    showAuthPanel(false);
    showToast("You have been logged out.");
  }
});

// Lightweight local chart renderer. It replaces the former CDN dependency
// while keeping all financial data on this device/server.
function drawLineChart(canvas, labels, series, height = 180) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const values = series.flatMap((s) => s.values).filter(Number.isFinite);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const pad = { top: 12, right: 12, bottom: 25, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const point = (value, index, count) => [
    pad.left + (count > 1 ? (index / (count - 1)) * plotW : plotW / 2),
    pad.top + plotH - ((value - min) / (max - min || 1)) * plotH,
  ];
  ctx.clearRect(0, 0, width, height);
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.fillStyle = "#6a7b77";
  ctx.strokeStyle = "#e3e9e6";
  for (let step = 0; step < 4; step++) {
    const y = pad.top + (step / 3) * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(
      `UGX ${Math.round(max - (step / 3) * (max - min)).toLocaleString()}`,
      0,
      y + 3,
    );
  }
  labels
    .filter(
      (_, i) =>
        i === 0 ||
        i === labels.length - 1 ||
        i % Math.ceil(labels.length / 4) === 0,
    )
    .forEach((label, index) => {
      const original = labels.indexOf(label, index);
      const [x] = point(0, original, labels.length);
      ctx.fillText(label, x - 8, height - 7);
    });
  series.forEach((s) => {
    ctx.beginPath();
    s.values.forEach((value, index) => {
      const [x, y] = point(value, index, s.values.length);
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

// ---- Nav ----
document.querySelectorAll(".nav-item").forEach((el) => {
  el.addEventListener("click", () => {
    if (
      !["businesses", "overall"].includes(el.dataset.tab) &&
      !currentBusinessId
    ) {
      showToast("Select a business first.", true);
      activateTab("businesses");
      return;
    }
    activateTab(el.dataset.tab);
  });
});

function loadTab(tab) {
  if (tab === "dashboard") loadDashboard();
  if (tab === "accounting") loadAccounting();
  if (tab === "inventory") loadInventory();
  if (tab === "market") loadMarket();
  if (tab === "sales") loadSales();
  if (tab === "news") loadNews();
}

async function loadNews() {
  const container = document.getElementById("news-list");
  const lockPanel = document.getElementById("news-lock-panel");
  if (!container) return;
  if (!planAllowed("news")) {
    lockPanel?.classList.remove("hidden");
    container.innerHTML = "";
    return;
  }
  lockPanel?.classList.add("hidden");
  container.innerHTML = `
    <div class="card">
      <div class="section-title">Latest business news</div>
      <div class="empty">News is configured server-side via the Supabase Edge Function. Deploy the function and refresh here to show live RSS items.</div>
    </div>
  `;
}

async function loadOverallProfitLoss() {
  try {
    const report = await api("/overall-profit-loss");
    document.getElementById("overall-income").textContent = fmt(
      report.total_income,
    );
    document.getElementById("overall-expenses").textContent = fmt(
      report.total_expenses,
    );
    const net = document.getElementById("overall-net");
    net.textContent = fmt(report.net_profit);
    net.className = `stat-value ${report.net_profit >= 0 ? "good" : "bad"}`;
    document.getElementById("overall-businesses").innerHTML = report.businesses
      .length
      ? report.businesses
          .map(
            (business) =>
              `<tr><td>${escapeHtml(business.name)}</td><td style="text-align:right">${fmt(business.income)}</td><td style="text-align:right">${fmt(business.expenses)}</td><td style="text-align:right" class="${business.net_profit >= 0 ? "good" : "bad"}">${fmt(business.net_profit)}</td></tr>`,
          )
          .join("")
      : '<tr><td colspan="4" class="empty">No businesses have been added yet.</td></tr>';
  } catch (error) {
    showToast(error.message, true);
  }
}

// ---- Dashboard ----
async function loadDashboard() {
  const d = await api("/dashboard" + reportQuery());
  const period = uiText(d.period_label);
  document.getElementById("d-sales-label").textContent =
    `${period} ${uiText("Sales")}`;
  document.getElementById("d-income-label").textContent =
    `${period} ${uiText("Income")}`;
  document.getElementById("d-expenses-label").textContent =
    `${period} ${uiText("Expenses")}`;
  document.getElementById("d-profit-label").textContent =
    `${period} ${uiText("Net Profit")}`;
  document.getElementById("d-sales").textContent = fmt(d.sales_total);
  document.getElementById("d-sales-units").textContent =
    `${d.sales_units} ${uiText("items invoiced")}`;
  document.getElementById("d-today-sales").textContent = fmt(d.today_sales);
  document.getElementById("d-today-expenses").textContent = fmt(
    d.today_expenses,
  );
  const netEl = document.getElementById("d-net-profit");
  netEl.textContent = fmt(d.net_profit_30d);
  netEl.className = "stat-value " + (d.net_profit_30d >= 0 ? "good" : "bad");
  document.getElementById("d-outstanding").textContent = fmt(
    d.outstanding_invoices,
  );
  document.getElementById("inventory-title").textContent =
    `${uiText("Inventory")} — ${period}`;
  document.getElementById("d-inventory-summary").innerHTML = `
          <span>Stock in<strong>${d.stock_in}</strong></span>
          <span>Stock out<strong>${d.stock_out}</strong></span>
          <span>Current value<strong>${fmt(d.inventory_value)}</strong></span>`;

  const lowStockEl = document.getElementById("d-low-stock");
  lowStockEl.innerHTML = d.low_stock.length
    ? d.low_stock
        .map(
          (p) =>
            `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);font-size:13.5px;">
      <span>${escapeHtml(p.name)}</span><span class="pill low">${p.stock_qty} ${escapeHtml(p.unit || "unit")} ${uiText("left")}</span>
    </div>`,
        )
        .join("")
    : `<div class="empty">${uiText("All stock levels healthy.")}</div>`;

  const topEl = document.getElementById("d-top-products");
  topEl.innerHTML =
    d.top_products
      .map(
        (p) =>
          `<tr><td>${escapeHtml(p.name)}</td><td>${p.qty_sold}</td><td>${fmt(p.revenue)}</td></tr>`,
      )
      .join("") ||
    `<tr><td colspan="3" class="empty">${uiText("No sales yet.")}</td></tr>`;
}

// ---- Accounting ----
async function loadAccounting() {
  const [pl, txns] = await Promise.all([
    api("/profit-loss" + reportQuery()),
    api("/transactions" + reportQuery()),
  ]);
  document.getElementById("pl-title").textContent =
    `${uiText("Profit & Loss")} — ${uiText(pl.period_label)}`;
  document.getElementById("pl-income").innerHTML =
    pl.income_by_category
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.category)}</td><td style="text-align:right">${fmt(r.total)}</td></tr>`,
      )
      .join("") ||
    `<tr><td class="empty">${uiText("No income recorded.")}</td></tr>`;
  document.getElementById("pl-expense").innerHTML =
    pl.expense_by_category
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.category)}</td><td style="text-align:right">${fmt(r.total)}</td></tr>`,
      )
      .join("") ||
    `<tr><td class="empty">${uiText("No expenses recorded.")}</td></tr>`;
  const netEl = document.getElementById("pl-net");
  netEl.textContent = fmt(pl.net_profit);
  netEl.style.color = pl.net_profit >= 0 ? "var(--good)" : "var(--bad)";

  document.getElementById("txn-list").innerHTML = txns
    .map(
      (t) => `<tr>
    <td>${formatLocalDate(t.occurred_at)}</td>
    <td><span class="pill ${t.type === "income" ? "ok" : "low"}">${escapeHtml(t.type)}</span></td>
    <td>${escapeHtml(t.category)}</td><td>${escapeHtml(t.description || "")}</td>
    <td style="text-align:right">${fmt(t.amount)}</td></tr>`,
    )
    .join("");
}

document.getElementById("txn-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const payload = Object.fromEntries(f);
  const button = document.getElementById("txn-submit");
  payload.amount = Number(payload.amount);
  if (
    !String(payload.category || "").trim() ||
    !Number.isFinite(payload.amount) ||
    payload.amount <= 0
  ) {
    showToast("Add a category and an amount greater than zero.", true);
    return;
  }
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    await api("/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    e.target.reset();
    const today = new Date();
    e.target.elements.occurred_at.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    await Promise.all([loadAccounting(), loadDashboard()]);
    showToast("Transaction saved — your profit and loss is up to date.");
  } catch (err) {
    showToast(err.message, true);
    console.error(err);
  } finally {
    button.disabled = false;
    button.textContent = "Add Transaction";
  }
});

// ---- Inventory ----
let productsCache = [];
async function loadInventory() {
  productsCache = await api("/products");
  document.getElementById("inv-list").innerHTML = productsCache
    .map((p) => {
      const status =
        p.stock_qty <= 0
          ? "Out of stock"
          : p.stock_qty <= LOW_STOCK_THRESHOLD
            ? "Low stock"
            : "Healthy";
      const statusClass =
        p.stock_qty <= 0
          ? "low"
          : p.stock_qty <= LOW_STOCK_THRESHOLD
            ? "low"
            : "ok";
      return `<tr>
    <td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.category || "")}</td>
    <td><span class="pill ${statusClass}">${p.stock_qty} ${escapeHtml(p.unit || "unit")}</span><div class="sub">${status}</div></td>
    <td>${p.stock_qty <= LOW_STOCK_THRESHOLD ? LOW_STOCK_THRESHOLD : "—"}</td><td>${fmt(p.cost_price)}</td><td>${fmt(p.sell_price)}</td>
    <td>
      <button class="btn small secondary" onclick="adjustStock(${p.id}, 10)">+10</button>
      <button class="btn small secondary" onclick="adjustStock(${p.id}, -10)">-10</button>
    </td></tr>`;
    })
    .join("");
}
async function adjustStock(id, delta) {
  await api(`/products/${id}/stock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delta }),
  });
  loadInventory();
}
document
  .getElementById("product-submit")
  .addEventListener("click", async () => {
    const form = document.getElementById("product-form");
    const submitButton = document.getElementById("product-submit");
    const f = new FormData(form);
    const payload = Object.fromEntries(f);
    submitButton.disabled = true;
    submitButton.textContent = "Saving…";
    try {
      await api("/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      form.reset();
      await loadInventory();
      showToast("Product saved.");
    } catch (err) {
      showToast(err.message || "Could not save product.", true);
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Add Product";
    }
  });

// ---- Market Intelligence ----
async function loadMarket() {
  const data = await api("/market-prices");
  const listEl = document.getElementById("market-list");
  listEl.innerHTML = "";
  data.forEach((item) => {
    const min = Math.min(
      item.your_cost_price,
      item.latest_supplier_price,
      item.your_sell_price,
      item.latest_market_price,
      item.suggested_sell_price,
    );
    const max = Math.max(
      item.your_cost_price,
      item.latest_supplier_price,
      item.your_sell_price,
      item.latest_market_price,
      item.suggested_sell_price,
    );
    const span = max - min || 1;
    const pct = (v) => ((v - min) / span) * 100;
    const trendUp =
      item.history.length > 1 &&
      item.history[item.history.length - 1].market_price >=
        item.history[0].market_price;

    const div = document.createElement("div");
    div.className = "card market-card";
    div.innerHTML = `
      <div class="head">
        <h3>${item.product_name}</h3>
        <span class="badge-trend ${trendUp ? "up" : "down"}">${trendUp ? "▲" : "▼"} 14-day trend</span>
      </div>
      <div class="flex" style="font-size:13px;color:var(--muted);margin-top:6px;">
        <span>Your price: <strong style="color:var(--ink)">${fmt(item.your_sell_price)}</strong></span>
        <span>Market price: <strong style="color:var(--ink)">${fmt(item.latest_market_price)}</strong></span>
        <span>Supplier (${item.latest_supplier_name}): <strong style="color:var(--ink)">${fmt(item.latest_supplier_price)}</strong></span>
        <span>Suggested price: <strong style="color:var(--amber)">${fmt(item.suggested_sell_price)}</strong></span>
      </div>
      <div class="price-gauge">
        <div class="bar" style="left:${pct(item.your_cost_price)}%;width:${pct(item.your_sell_price) - pct(item.your_cost_price)}%;"></div>
        <div class="marker" style="left:${pct(item.latest_market_price)}%;"><div class="tag">Market</div></div>
        <div class="marker" style="left:${pct(item.your_sell_price)}%;border-color:var(--amber);background:var(--amber);"><div class="tag" style="color:var(--amber)">You</div></div>
      </div>
      <canvas id="chart-${item.product_id}" style="margin-top:14px;"></canvas>
    `;
    listEl.appendChild(div);
    const chart = document.getElementById(`chart-${item.product_id}`);
    chart.className = "chart-canvas";
    drawLineChart(
      chart,
      item.history.map((h) => h.recorded_at.slice(5, 10)),
      [
        { values: item.history.map((h) => h.market_price), color: "#0b4f4a" },
        { values: item.history.map((h) => h.supplier_price), color: "#e8a33d" },
      ],
      120,
    );
  });

  const select = document.getElementById("market-product-select");
  select.innerHTML = productsCache.length
    ? productsCache
        .map((p) => `<option value="${p.id}">${p.name}</option>`)
        .join("")
    : (await refreshProductsCache(),
      productsCache
        .map((p) => `<option value="${p.id}">${p.name}</option>`)
        .join(""));
}
async function refreshProductsCache() {
  productsCache = await api("/products");
}

document.getElementById("market-submit").addEventListener("click", async () => {
  const f = new FormData(document.getElementById("market-form"));
  await api("/market-prices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.fromEntries(f)),
  });
  loadMarket();
});

// ---- Sales ----
let customersCache = [];
async function loadSales() {
  await refreshProductsCache();
  customersCache = await api("/customers");
  document.getElementById("invoice-customer-select").innerHTML = customersCache
    .map((c) => `<option value="${c.id}">${c.name}</option>`)
    .join("");
  document.getElementById("invoice-product-select").innerHTML = productsCache
    .map(
      (p) =>
        `<option value="${p.id}">${p.name} (${fmt(p.sell_price)})</option>`,
    )
    .join("");

  const invoices = await api("/invoices");
  document.getElementById("invoice-list").innerHTML = invoices
    .map(
      (i) => `<tr>
    <td>${formatLocalDate(i.created_at)}</td><td>${escapeHtml(i.customer_name)}</td><td>${escapeHtml(i.product_name)}</td>
    <td>${i.qty}</td><td>${fmt(i.unit_price)}</td><td>${fmt(i.total)}</td>
    <td><span class="pill ${i.status}">${escapeHtml(i.status)}</span></td>
    <td>${i.status === "unpaid" ? `<button class="btn small secondary" onclick="markPaid(${i.id})">Mark Paid</button>` : ""}</td>
    </tr>`,
    )
    .join("");
}
async function markPaid(id) {
  const confirmed = confirm(
    "Confirm payment received and mark this invoice as paid?",
  );
  if (!confirmed) return;
  try {
    await api(`/invoices/${id}/mark-paid`, { method: "POST" });
    showToast("Invoice marked paid.");
    await Promise.all([loadSales(), loadDashboard()]);
  } catch (err) {
    showToast(err.message || "Could not mark invoice paid.", true);
    console.error(err);
  }
}
document
  .getElementById("invoice-submit")
  .addEventListener("click", async () => {
    const form = document.getElementById("invoice-form");
    const submitButton = document.getElementById("invoice-submit");
    const f = new FormData(form);
    const payload = Object.fromEntries(f);
    payload.qty = Number(payload.qty);
    payload.unit_price = Number(payload.unit_price);
    submitButton.disabled = true;
    submitButton.textContent = "Saving…";

    try {
      if (!String(payload.customer_name || "").trim())
        throw new Error("Customer name is required.");
      if (!String(payload.product_name || "").trim())
        throw new Error("Product name is required.");
      if (!Number.isFinite(payload.qty) || payload.qty <= 0)
        throw new Error(
          "Invoice qty must be a finite number greater than zero.",
        );
      if (!Number.isFinite(payload.unit_price) || payload.unit_price < 0)
        throw new Error(
          "Invoice unit price must be a finite number greater than or equal to zero.",
        );
      await api("/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      showToast("Invoice created.");
      form.reset();
      await Promise.all([loadSales(), loadInventory(), loadDashboard()]);
    } catch (err) {
      showToast(err.message || "Could not create invoice.", true);
      console.error(err);
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Create Invoice";
    }
  });

// The app starts at Businesses. Select a business, then choose a feature manually.
