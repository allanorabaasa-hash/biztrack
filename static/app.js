const fmt = (n) => "UGX " + Math.round(n).toLocaleString();
const uiText = (value) => value;
let currentBusinessId = "";
let businesses = [];
let contextBusinessId = "";
// Browser-only encrypted data store. No HTTP requests or server APIs are used.
const ACCOUNTS_KEY = "biztrack-offline-accounts-v1";
const STORE_PREFIX = "biztrack-offline-data-v2-";
let activeUser = null;
const emptyStore = () => ({
  businesses: [],
  products: [],
  customers: [],
  transactions: [],
  invoices: [],
  stockMovements: [],
  marketPrices: [],
});
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
  const raw = localStorage.getItem(STORE_PREFIX + activeUser.id);
  if (!raw) return emptyStore();
  try {
    const payload = JSON.parse(raw);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
      activeUser.key,
      base64ToBytes(payload.data),
    );
    return {
      ...emptyStore(),
      ...JSON.parse(new TextDecoder().decode(decrypted)),
    };
  } catch {
    throw new Error("Your private data could not be unlocked.");
  }
};
const writeStore = async (store) =>
  localStorage.setItem(STORE_PREFIX + activeUser.id, await encryptStore(store));
const nextId = (rows) =>
  Math.max(0, ...rows.map((row) => Number(row.id) || 0)) + 1;
const requestData = (opts) => (opts?.body ? JSON.parse(opts.body) : {});
const requireBusiness = () => {
  if (!currentBusinessId) throw new Error("Select a business first.");
  return Number(currentBusinessId);
};
const reportRange = (params) => {
  const period = params.get("period") || "monthly";
  const end = new Date();
  end.setHours(24, 0, 0, 0);
  const start = new Date(end);
  if (period === "daily") start.setDate(start.getDate() - 1);
  else if (period === "weekly") start.setDate(start.getDate() - 7);
  else if (period === "custom")
    return {
      start: new Date(`${params.get("start")}T00:00:00`),
      end: new Date(`${params.get("end")}T23:59:59`),
      label: "Custom period",
    };
  else start.setDate(start.getDate() - 30);
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
      if (!data.category || !Number.isFinite(amount) || amount <= 0)
        throw new Error("Add a category and an amount greater than zero.");
      const transaction = {
        id: nextId(store.transactions),
        business_id: id,
        type: data.type,
        category: String(data.category),
        description: String(data.description || ""),
        amount,
        occurred_at: new Date().toISOString(),
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
      const product = {
        id: nextId(store.products),
        business_id: id,
        name: String(data.name || "").trim(),
        category: String(data.category || ""),
        unit: String(data.unit || "unit"),
        stock_qty: Number(data.stock_qty || 0),
        reorder_level: Number(data.reorder_level || 0),
        cost_price: Number(data.cost_price || 0),
        sell_price: Number(data.sell_price || 0),
      };
      if (!product.name) throw new Error("Product name is required.");
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
    product.stock_qty += delta;
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
      let customer = scoped(store.customers).find(
        (row) => row.id === Number(data.customer_id),
      );
      const customerName = String(
        data.customer_name || data.customer_text || "",
      ).trim();
      if (!customer && customerName) {
        customer = scoped(store.customers).find(
          (row) => row.name.toLowerCase() === customerName.toLowerCase(),
        ) || {
          id: nextId(store.customers),
          business_id: id,
          name: customerName,
        };
        if (!store.customers.some((row) => row.id === customer.id))
          store.customers.push(customer);
      }
      if (!customer) throw new Error("Provide a customer name.");
      const product = scoped(store.products).find(
        (row) => row.id === Number(data.product_id),
      );
      if (!product) throw new Error("Choose a product.");
      const qty = Number(data.qty);
      const unit_price = Number(data.unit_price || product.sell_price);
      const invoice = {
        id: nextId(store.invoices),
        business_id: id,
        customer_id: customer.id,
        product_id: product.id,
        qty,
        unit_price,
        status: data.status || "unpaid",
        created_at: new Date().toISOString(),
      };
      store.invoices.push(invoice);
      product.stock_qty -= qty;
      store.stockMovements.push({
        id: nextId(store.stockMovements),
        business_id: id,
        product_id: product.id,
        change_qty: -qty,
        occurred_at: invoice.created_at,
      });
      if (invoice.status === "paid")
        store.transactions.push({
          id: nextId(store.transactions),
          business_id: id,
          type: "income",
          category: "Sales",
          description: "Invoice sale",
          amount: qty * unit_price,
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
    const byDate = {};
    transactions.forEach((row) => {
      const date = row.occurred_at.slice(0, 10);
      byDate[date] = byDate[date] || { d: date, income: 0, expense: 0 };
      byDate[date][row.type] += Number(row.amount);
    });
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
      cash_flow_series: Object.values(byDate).sort((a, b) =>
        a.d.localeCompare(b.d),
      ),
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
const isoDate = (date) => date.toISOString().slice(0, 10);
const reportQuery = () => {
  const params = new URLSearchParams({ period: activePeriod });
  if (activePeriod === "custom") {
    params.set("start", document.getElementById("report-start").value);
    params.set("end", document.getElementById("report-end").value);
  }
  return `?${params.toString()}`;
};
const reloadReports = () =>
  Promise.all([loadDashboard(), loadAccounting()]).catch((error) =>
    showToast(error.message, true),
  );

const periodSelect = document.getElementById("report-period");
const customRange = document.getElementById("custom-date-range");
const today = new Date();
document.getElementById("report-end").value = isoDate(today);
document.getElementById("report-start").value = isoDate(
  new Date(today.getTime() - 29 * 86400000),
);
periodSelect.addEventListener("change", () => {
  activePeriod = periodSelect.value;
  customRange.classList.toggle("hidden", activePeriod !== "custom");
  if (activePeriod !== "custom") reloadReports();
});
document.getElementById("apply-custom-period").addEventListener("click", () => {
  const start = document.getElementById("report-start").value;
  const end = document.getElementById("report-end").value;
  if (!start || !end || end < start) {
    showToast("Choose a start date that comes before the end date.", true);
    return;
  }
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
  document
    .querySelectorAll(".nav-item")
    .forEach((item) =>
      item.classList.toggle("active", item.dataset.tab === tab),
    );
  document
    .querySelectorAll(".tab")
    .forEach((item) => item.classList.add("hidden"));
  document.getElementById(`tab-${tab}`).classList.remove("hidden");
  if (window.innerWidth <= 900) closeMobileMenu();
  if (tab === "overall") loadOverallProfitLoss();
  if (["dashboard", "accounting", "inventory", "market", "sales"].includes(tab))
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
          `<option value="${business.id}">${business.name}</option>`,
      )
      .join("");
  select.value = currentBusinessId;
  document.getElementById("business-list").innerHTML = businesses.length
    ? businesses
        .map(
          (business) =>
            `<button class="business-row${String(business.id) === String(currentBusinessId) ? " selected" : ""}" data-business-id="${business.id}"><strong>${business.name}</strong><span>${business.business_type || "Business"}</span></button>`,
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
  localStorage.setItem("biztrack-business-id", currentBusinessId);
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
const accounts = () => JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "[]");
const saveAccounts = (items) =>
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(items));
const authMessage = (message = "") => {
  document.getElementById("auth-message").textContent = message;
};
const showAuthPanel = (signup) => {
  document.getElementById("login-panel").classList.toggle("hidden", signup);
  document.getElementById("signup-panel").classList.toggle("hidden", !signup);
  authMessage();
};
const beginSession = async (account, key) => {
  activeUser = { id: account.id, key };
  currentBusinessId =
    sessionStorage.getItem(`biztrack-business-${account.id}`) || "";
  document.getElementById("auth-screen").classList.add("hidden");
  await loadBusinesses();
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
    if (accounts().some((account) => account.email === email))
      return authMessage("An account already exists for this email.");
    try {
      const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
      const { key, verifier } = await deriveKey(password, salt);
      const account = {
        id: crypto.randomUUID(),
        name: String(values.name).trim(),
        email,
        salt,
        verifier,
      };
      saveAccounts([...accounts(), account]);
      await beginSession(account, key);
    } catch {
      authMessage("Secure storage is not available in this browser.");
    }
  });
document
  .getElementById("login-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const account = accounts().find(
      (item) => item.email === String(values.email).trim().toLowerCase(),
    );
    if (!account) return authMessage("Incorrect email or password.");
    try {
      const { key, verifier } = await deriveKey(
        String(values.password),
        account.salt,
      );
      if (verifier !== account.verifier)
        return authMessage("Incorrect email or password.");
      await beginSession(account, key);
    } catch {
      authMessage(
        "Incorrect email or password, or private data could not be unlocked.",
      );
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
              `<tr><td>${business.name}</td><td style="text-align:right">${fmt(business.income)}</td><td style="text-align:right">${fmt(business.expenses)}</td><td style="text-align:right" class="${business.net_profit >= 0 ? "good" : "bad"}">${fmt(business.net_profit)}</td></tr>`,
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
  document.getElementById("cashflow-title").textContent =
    `${uiText("Cash Flow")} — ${period}`;
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
      <span>${p.name}</span><span class="pill low">${p.stock_qty} ${p.unit} ${uiText("left")}</span>
    </div>`,
        )
        .join("")
    : `<div class="empty">${uiText("All stock levels healthy.")}</div>`;

  const topEl = document.getElementById("d-top-products");
  topEl.innerHTML =
    d.top_products
      .map(
        (p) =>
          `<tr><td>${p.name}</td><td>${p.qty_sold}</td><td>${fmt(p.revenue)}</td></tr>`,
      )
      .join("") ||
    `<tr><td colspan="3" class="empty">${uiText("No sales yet.")}</td></tr>`;

  const labels = d.cash_flow_series.map((r) => r.d.slice(5));
  const income = d.cash_flow_series.map((r) => r.income);
  const expense = d.cash_flow_series.map((r) => r.expense);
  drawLineChart(
    document.getElementById("cashflow-chart"),
    labels,
    [
      { values: income, color: "#0b4f4a" },
      { values: expense, color: "#e4572e" },
    ],
    220,
  );
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
          `<tr><td>${r.category}</td><td style="text-align:right">${fmt(r.total)}</td></tr>`,
      )
      .join("") ||
    `<tr><td class="empty">${uiText("No income recorded.")}</td></tr>`;
  document.getElementById("pl-expense").innerHTML =
    pl.expense_by_category
      .map(
        (r) =>
          `<tr><td>${r.category}</td><td style="text-align:right">${fmt(r.total)}</td></tr>`,
      )
      .join("") ||
    `<tr><td class="empty">${uiText("No expenses recorded.")}</td></tr>`;
  const netEl = document.getElementById("pl-net");
  netEl.textContent = fmt(pl.net_profit);
  netEl.style.color = pl.net_profit >= 0 ? "var(--good)" : "var(--bad)";

  document.getElementById("txn-list").innerHTML = txns
    .map(
      (t) => `<tr>
    <td>${t.occurred_at.slice(0, 10)}</td>
    <td><span class="pill ${t.type === "income" ? "ok" : "low"}">${t.type}</span></td>
    <td>${t.category}</td><td>${t.description || ""}</td>
    <td style="text-align:right">${fmt(t.amount)}</td></tr>`,
    )
    .join("");
}

document.getElementById("txn-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const payload = Object.fromEntries(f);
  payload.amount = Number(payload.amount);
  const button = document.getElementById("txn-submit");
  if (
    !payload.category.trim() ||
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
    .map(
      (p) => `<tr>
    <td>${p.name}</td><td>${p.category || ""}</td>
    <td><span class="pill ${p.stock_qty <= p.reorder_level ? "low" : "ok"}">${p.stock_qty} ${p.unit}</span></td>
    <td>${p.reorder_level}</td><td>${fmt(p.cost_price)}</td><td>${fmt(p.sell_price)}</td>
    <td>
      <button class="btn small secondary" onclick="adjustStock(${p.id}, 10)">+10</button>
      <button class="btn small secondary" onclick="adjustStock(${p.id}, -10)">-10</button>
    </td></tr>`,
    )
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
    const f = new FormData(document.getElementById("product-form"));
    await api("/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(f)),
    });
    document.getElementById("product-form").reset();
    loadInventory();
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
    <td>${i.created_at.slice(0, 10)}</td><td>${i.customer_name}</td><td>${i.product_name}</td>
    <td>${i.qty}</td><td>${fmt(i.unit_price)}</td><td>${fmt(i.total)}</td>
    <td><span class="pill ${i.status}">${i.status}</span></td>
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
    const f = new FormData(document.getElementById("invoice-form"));
    const payload = Object.fromEntries(f);
    const customerText = (payload.customer_text || "").trim();
    if (customerText) {
      // If user typed a customer, prefer that (name or numeric id) over the select value.
      payload.customer_name = customerText;
      delete payload.customer_id;
    }
    // Remove empty optional fields to avoid sending empty strings
    if (!payload.unit_price) delete payload.unit_price;

    try {
      await api("/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      showToast("Invoice created.");
      document.getElementById("invoice-form").reset();
      await Promise.all([loadSales(), loadInventory(), loadDashboard()]);
    } catch (err) {
      showToast(err.message || "Could not create invoice.", true);
      console.error(err);
    }
  });

// The app starts at Businesses. Select a business, then choose a feature manually.
