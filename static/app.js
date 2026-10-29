const LOW_STOCK_THRESHOLD = 5;
const capacitor = window.Capacitor;
const isNativeApp = Boolean(capacitor?.isNativePlatform?.());
const authRedirectUrl = isNativeApp
  ? "https://allanorabaasa-hash.github.io/biztrack/"
  : new URL("./", window.location.href).href;
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
const accessState = (account = activeUser) => {
  const now = Date.now();
  const candidate = account?.plan || activePlan || "basic";
  const plan = PLAN_CONFIG[candidate] ? candidate : "basic";
  const paid = Boolean(
    account?.planExpiresAt && Date.parse(account.planExpiresAt) > now,
  );
  const trial = Boolean(
    account?.trialEndsAt && Date.parse(account.trialEndsAt) > now,
  );
  const active = paid ? plan : "basic";
  const expiresAt = paid
    ? account.planExpiresAt
    : trial
    ? account.trialEndsAt
    : null;
  return {
    access: paid ? "paid" : trial ? "trial" : "read_only",
    plan: active,
    expiresAt: expiresAt ? Date.parse(expiresAt) : null,
    daysLeft: expiresAt
      ? Math.ceil((Date.parse(expiresAt) - now) / 86400000)
      : 0,
  };
};
// "6 days left", "5 hours left", "less than an hour left". Rounds down so the
// count visibly goes down each day (rounding up showed 7 days for a whole day).
const timeLeftLabel = (expiresAt) => {
  const ms = Math.max(0, Number(expiresAt) - Date.now());
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} left`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"} left`;
  return "less than an hour left";
};
const shortDate = (time) =>
  new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const isReadOnly = () =>
  Boolean(activeUser) && accessState().access === "read_only";
const requireWriteAccess = () => {
  if (isReadOnly()) {
    throw new Error(
      "Your free trial / plan has ended. Your data is safe. Pay to continue adding records.",
    );
  }
};
// Calls a Supabase Edge Function and turns failures into readable errors.
const invokeFunction = async (name, body) => {
  if (!supabaseClient) throw new Error("Supabase is not configured.");
  const { data, error } = await supabaseClient.functions.invoke(name, { body });
  if (!error) return data;
  let payload = null;
  try {
    payload = await error.context?.json?.();
  } catch {
    payload = null;
  }
  const failure = new Error(
    payload?.error || error.message || "The request could not be completed.",
  );
  failure.status = error.context?.status;
  failure.payload = payload;
  throw failure;
};
// Store the server's view of this user's access (plan, trial, expiry).
const applyAccess = async (access) => {
  if (!activeUser || !access) return;
  activeUser.trialEndsAt = access.trialEndsAt || null;
  activeUser.planExpiresAt = access.planExpiresAt || null;
  activeUser.plan = access.plan || "basic";
  activeUser.trialMode = Boolean(
    access.trialEndsAt && Date.parse(access.trialEndsAt) > Date.now(),
  );
  activePlan = accessState().plan;
  const local = (await localWorkspace(activeUser.id)) || {
    user_id: activeUser.id,
  };
  await saveLocalWorkspace({
    ...local,
    plan: activeUser.plan,
    trialEndsAt: activeUser.trialEndsAt,
    planExpiresAt: activeUser.planExpiresAt,
    trialMode: activeUser.trialMode,
  });
  const accountPlan = document.getElementById("account-plan");
  if (accountPlan)
    accountPlan.textContent = PLAN_CONFIG[activePlan]?.name || "BizTrack Basic";
  updatePlanUI();
};
// Ask the server for current access. Returns false when offline or failing.
const refreshAccessFromServer = async () => {
  if (!activeUser || !navigator.onLine || !supabaseClient) return false;
  try {
    const access = await invokeFunction("select-plan", {
      validateCurrent: true,
    });
    await applyAccess(access);
    return true;
  } catch (error) {
    console.warn("Access refresh deferred:", error);
    return false;
  }
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
// Opened from a "reset your password" email? (Read before Supabase clears the URL.)
const openedFromResetLink = /type=recovery/.test(
  `${window.location.hash}${window.location.search}`,
);
const supabaseClient =
  hasSupabaseConfig && window.supabase?.createClient
    ? window.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey)
    : null;
let activeUser = null;
let activePlan = "";
let trialExpiryNoticeFor = "";
let accessExpiryTimer;
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
const createRecoveryCode = () =>
  crypto
    .randomUUID()
    .replace(/-/g, "")
    .toUpperCase()
    .match(/.{1,4}/g)
    .join("-");
const wrapRawKey = async (rawKey, wrappingKey) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    rawKey,
  );
  return JSON.stringify({
    iv: bytesToBase64(iv),
    data: bytesToBase64(encrypted),
  });
};
const unwrapDataKey = async (wrapped, wrappingKey) => {
  const payload = JSON.parse(wrapped);
  const rawKey = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
    wrappingKey,
    base64ToBytes(payload.data),
  );
  return crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};
const createDataKeyBundle = async (passwordKey) => {
  const generated = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const rawKey = await crypto.subtle.exportKey("raw", generated);
  const dataKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const recoveryCode = createRecoveryCode();
  const recoverySalt = bytesToBase64(
    crypto.getRandomValues(new Uint8Array(16)),
  );
  const recoveryKey = await deriveKey(
    recoveryCode.replace(/-/g, ""),
    recoverySalt,
  );
  return {
    dataKey,
    dataKeyWrapped: await wrapRawKey(rawKey, passwordKey),
    recoveryKeyWrapped: JSON.stringify({
      salt: recoverySalt,
      wrapped: await wrapRawKey(rawKey, recoveryKey.key),
    }),
    recoveryCode,
  };
};
const unlockWithRecoveryCode = async (email, recoveryCode) => {
  const account = await findLocalAccount(email);
  if (!account?.encrypted_data || !account.recovery_key_wrapped)
    throw new Error(
      "No recovery key is saved on this device. Connect and sign in first.",
    );
  const recovery = JSON.parse(account.recovery_key_wrapped);
  const recoveryKeys = await deriveKey(
    String(recoveryCode)
      .replace(/[^a-z0-9]/gi, "")
      .toUpperCase(),
    recovery.salt,
  );
  const key = await unwrapDataKey(recovery.wrapped, recoveryKeys.key);
  await decryptPayload(account.encrypted_data, key);
  await beginSession(
    {
      ...account,
      id: account.user_id,
      plan: account.plan || "",
      dataKeyWrapped: account.data_key_wrapped,
      recoveryKeyWrapped: account.recovery_key_wrapped,
    },
    key,
  );
  await openWorkspaceFromLocal();
};
const showRecoveryCode = (code) => {
  if (!code) return;
  window.alert(
    `Save this recovery code somewhere private. It is shown only once and can unlock your workspace if you lose your password:\n\n${code}`,
  );
};
const encryptStore = async (store, key = activeUser.key) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(store)),
  );
  return JSON.stringify({
    iv: bytesToBase64(iv),
    data: bytesToBase64(encrypted),
  });
};
const LOCAL_DB_NAME = "biztrack-local-v1";
const LOCAL_STORE_NAME = "workspaces";
const RECORD_COLLECTIONS = [
  "businesses",
  "products",
  "customers",
  "transactions",
  "invoices",
  "stockMovements",
  "marketPrices",
];
let localDbPromise;
let syncTimer;
let syncInProgress = false;
let syncRetryDelay = 10000;
let syncNeedsLogin = false;
const openLocalDb = () => {
  if (!localDbPromise) {
    localDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(LOCAL_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(LOCAL_STORE_NAME))
          request.result.createObjectStore(LOCAL_STORE_NAME, {
            keyPath: "user_id",
          });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return localDbPromise;
};
const localWorkspace = async (userId) => {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(LOCAL_STORE_NAME)
      .objectStore(LOCAL_STORE_NAME)
      .get(userId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
};
const saveLocalWorkspace = async (record) => {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LOCAL_STORE_NAME, "readwrite");
    transaction.objectStore(LOCAL_STORE_NAME).put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
};
const removeLocalWorkspace = async (userId) => {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LOCAL_STORE_NAME, "readwrite");
    transaction.objectStore(LOCAL_STORE_NAME).delete(userId);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
};
const findLocalAccount = async (email) => {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(LOCAL_STORE_NAME)
      .objectStore(LOCAL_STORE_NAME)
      .getAll();
    request.onsuccess = () =>
      resolve(
        request.result.find((item) => item.email?.toLowerCase() === email) ||
          null,
      );
    request.onerror = () => reject(request.error);
  });
};
const decryptPayload = async (encryptedData, key) => {
  const payload = JSON.parse(encryptedData);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
    key,
    base64ToBytes(payload.data),
  );
  return {
    ...emptyStore(),
    ...JSON.parse(new TextDecoder().decode(decrypted)),
  };
};
const migrateLegacyWorkspace = async ({
  userId,
  email,
  salt,
  passwordKey,
  initialWorkspace,
}) => {
  let workspace = initialWorkspace;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      const latest = await supabaseClient
        .from("biztrack_workspaces")
        .select(
          "encrypted_data, updated_at, salt, data_key_wrapped, recovery_key_wrapped",
        )
        .eq("user_id", userId)
        .maybeSingle();
      if (latest.error) throw latest.error;
      workspace = latest.data;
    }
    if (workspace?.data_key_wrapped) {
      const dataKey = await unwrapDataKey(
        workspace.data_key_wrapped,
        passwordKey,
      );
      return {
        dataKey,
        dataKeyWrapped: workspace.data_key_wrapped,
        recoveryKeyWrapped: workspace.recovery_key_wrapped || null,
        recoveryCode: null,
      };
    }
    const remoteStore = workspace?.encrypted_data
      ? await decryptPayload(workspace.encrypted_data, passwordKey)
      : emptyStore();
    let combined = remoteStore;
    const cached = await localWorkspace(userId);
    if (cached?.encrypted_data && cached.unsynced) {
      try {
        const cachedStore = await decryptPayload(
          cached.encrypted_data,
          passwordKey,
        );
        combined = mergeWorkspaces(cachedStore, remoteStore);
      } catch {
        throw new Error(
          "Local changes could not be safely migrated. Keep this device data and retry.",
        );
      }
    }
    const bundle = await createDataKeyBundle(passwordKey);
    const encryptedData = await encryptStore(combined, bundle.dataKey);
    const updatedAt = new Date().toISOString();
    const payload = {
      user_id: userId,
      salt,
      encrypted_data: encryptedData,
      data_key_wrapped: bundle.dataKeyWrapped,
      recovery_key_wrapped: bundle.recoveryKeyWrapped,
      updated_at: updatedAt,
    };
    let result;
    if (workspace?.updated_at) {
      result = await supabaseClient
        .from("biztrack_workspaces")
        .update(payload)
        .eq("user_id", userId)
        .eq("updated_at", workspace.updated_at)
        .select("updated_at")
        .maybeSingle();
    } else {
      result = await supabaseClient
        .from("biztrack_workspaces")
        .insert(payload)
        .select("updated_at")
        .maybeSingle();
    }
    if (result.error) {
      if (result.error.code === "23505" || result.error.code === "PGRST116")
        continue;
      throw result.error;
    }
    if (!result.data) continue;
    await saveLocalWorkspace({
      ...(cached || {}),
      user_id: userId,
      email,
      salt,
      cachedKey: bundle.dataKey,
      legacyPasswordKey: null,
      data_key_wrapped: bundle.dataKeyWrapped,
      recovery_key_wrapped: bundle.recoveryKeyWrapped,
      plan: cached?.plan || "",
      encrypted_data: encryptedData,
      updated_at: updatedAt,
      last_synced_at: new Date().toISOString(),
      unsynced: false,
    });
    return bundle;
  }
  throw new Error(
    "Workspace changed repeatedly during key migration. Your existing data was not replaced.",
  );
};
const setSyncStatus = (state, lastSyncedAt = null) => {
  const labels = {
    synced: "Synced",
    saving: "Saving…",
    offline: "Offline — changes saved on this device",
    failed: "Sync failed — will retry",
    auth: "Sign in to sync — changes saved here",
    pending: "Changes not synced",
    none: "Not synced",
  };
  const time = lastSyncedAt
    ? ` · ${new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(lastSyncedAt))}`
    : "";
  ["sync-status", "mobile-sync-status"].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.textContent = `${labels[state] || labels.none}${time}`;
  });
  const syncButton = document.getElementById("sync-now-button");
  if (syncButton)
    syncButton.textContent = syncNeedsLogin ? "Log in to sync" : "Sync now";
};
const queueWorkspaceSync = () => {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncWorkspace(), 3000);
};
const requireMatchingAuthSession = async (userId) => {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw error;
  if (data.session?.user?.id !== userId) {
    const authError = new Error("Log in to sync this account.");
    authError.status = 401;
    throw authError;
  }
};
const recordTime = (record) =>
  record.updated_at ||
  record.created_at ||
  record.occurred_at ||
  record.recorded_at ||
  "1970-01-01T00:00:00.000Z";
const stampWorkspaceChanges = (store, previous) => {
  const now = new Date().toISOString();
  store.deletedRecords ||= {};
  RECORD_COLLECTIONS.forEach((collection) => {
    const before = previous?.[collection] || [];
    const after = store[collection] || [];
    const beforeById = new Map(
      before.map((record) => [String(record.id), record]),
    );
    const afterIds = new Set(after.map((record) => String(record.id)));
    after.forEach((record) => {
      const original = beforeById.get(String(record.id));
      if (!original) {
        record.created_at ||= now;
        record.updated_at ||= now;
      } else if (JSON.stringify(original) !== JSON.stringify(record)) {
        record.updated_at = now;
      }
    });
    const deleted = store.deletedRecords[collection] || [];
    before.forEach((record) => {
      if (
        !afterIds.has(String(record.id)) &&
        !deleted.some((item) => String(item.id) === String(record.id))
      )
        deleted.push({ id: record.id, deleted_at: now });
    });
    store.deletedRecords[collection] = deleted;
  });
};
const mergeWorkspaces = (local, remote) => {
  const merged = { ...emptyStore(), ...remote, ...local, deletedRecords: {} };
  RECORD_COLLECTIONS.forEach((collection) => {
    const deletions = new Map();
    [
      ...(remote.deletedRecords?.[collection] || []),
      ...(local.deletedRecords?.[collection] || []),
    ].forEach((item) => {
      const key = String(item.id);
      const current = deletions.get(key);
      if (!current || item.deleted_at > current.deleted_at)
        deletions.set(key, item);
    });
    merged.deletedRecords[collection] = [...deletions.values()];
    const records = new Map();
    [...(remote[collection] || []), ...(local[collection] || [])].forEach(
      (record) => {
        const key = String(record.id);
        const current = records.get(key);
        if (!current || recordTime(record) >= recordTime(current))
          records.set(key, record);
      },
    );
    merged[collection] = [...records.values()].filter((record) => {
      const deletion = deletions.get(String(record.id));
      return !deletion || recordTime(record) > deletion.deleted_at;
    });
  });
  return merged;
};
const readStore = async () => {
  if (!activeUser) throw new Error("Unlock your workspace to continue.");
  const local = await localWorkspace(activeUser.id);
  if (local?.encrypted_data) {
    try {
      return await decryptPayload(local.encrypted_data, activeUser.key);
    } catch {
      throw new Error("Your private data could not be unlocked.");
    }
  }
  if (!navigator.onLine || !supabaseClient) return emptyStore();
  const { data: workspace, error } = await supabaseClient
    .from("biztrack_workspaces")
    .select(
      "encrypted_data, updated_at, salt, data_key_wrapped, recovery_key_wrapped",
    )
    .eq("user_id", activeUser.id)
    .maybeSingle();
  if (error) throw new Error("Your workspace could not be loaded.");
  if (!workspace?.encrypted_data) return emptyStore();
  try {
    let parsed;
    if (workspace.data_key_wrapped) {
      parsed = await decryptPayload(workspace.encrypted_data, activeUser.key);
    } else {
      if (!activeUser.legacyPasswordKey)
        throw new Error(
          "Legacy workspace requires a password login to finish safe key migration.",
        );
      parsed = await decryptPayload(
        workspace.encrypted_data,
        activeUser.legacyPasswordKey,
      );
      const migrated = await migrateLegacyWorkspace({
        userId: activeUser.id,
        email: activeUser.email,
        salt: workspace.salt || activeUser.salt,
        passwordKey: activeUser.legacyPasswordKey,
        initialWorkspace: workspace,
      });
      activeUser.key = migrated.dataKey;
      activeUser.dataKeyWrapped = migrated.dataKeyWrapped;
      activeUser.recoveryKeyWrapped = migrated.recoveryKeyWrapped;
      activeUser.legacyPasswordKey = null;
      const migratedLocal = await localWorkspace(activeUser.id);
      if (migratedLocal?.encrypted_data)
        parsed = await decryptPayload(
          migratedLocal.encrypted_data,
          activeUser.key,
        );
      setSyncStatus("synced", migratedLocal?.last_synced_at);
      return parsed;
    }
    activeUser.workspaceUpdatedAt = workspace.updated_at || null;
    await saveLocalWorkspace({
      ...(local || {}),
      user_id: activeUser.id,
      email: activeUser.email || "",
      cachedKey: activeUser.key,
      legacyPasswordKey: workspace.data_key_wrapped
        ? null
        : activeUser.legacyPasswordKey,
      data_key_wrapped: workspace.data_key_wrapped || null,
      recovery_key_wrapped: workspace.recovery_key_wrapped || null,
      salt: workspace.salt || activeUser.salt,
      plan: activePlan || local?.plan || "",
      encrypted_data: workspace.encrypted_data,
      updated_at: workspace.updated_at || null,
      last_synced_at: new Date().toISOString(),
      unsynced: false,
    });
    return parsed;
  } catch {
    throw new Error("Your private data could not be unlocked.");
  }
};
const writeStore = async (store) => {
  if (!activeUser) throw new Error("Unlock your workspace to continue.");
  requireWriteAccess();
  const previousLocal = await localWorkspace(activeUser.id);
  let previous = null;
  if (previousLocal?.encrypted_data) {
    try {
      previous = await decryptPayload(
        previousLocal.encrypted_data,
        activeUser.key,
      );
    } catch {
      previous = null;
    }
  }
  stampWorkspaceChanges(store, previous);
  const encryptedData = await encryptStore(store);
  await saveLocalWorkspace({
    ...(previousLocal || {}),
    user_id: activeUser.id,
    email: activeUser.email || previousLocal?.email || "",
    salt: activeUser.salt,
    cachedKey: activeUser.key,
    data_key_wrapped:
      activeUser.dataKeyWrapped || previousLocal?.data_key_wrapped || null,
    recovery_key_wrapped:
      activeUser.recoveryKeyWrapped ||
      previousLocal?.recovery_key_wrapped ||
      null,
    plan: activePlan || previousLocal?.plan || "",
    encrypted_data: encryptedData,
    updated_at: previousLocal?.updated_at || null,
    last_synced_at: previousLocal?.last_synced_at || null,
    unsynced: true,
  });
  setSyncStatus(
    navigator.onLine ? "saving" : "offline",
    previousLocal?.last_synced_at,
  );
  queueWorkspaceSync();
};
const syncWorkspace = async () => {
  if (syncInProgress || !activeUser || !navigator.onLine || !supabaseClient)
    return;
  syncInProgress = true;
  const userId = activeUser.id;
  let attemptedCiphertext = null;
  let failed = false;
  try {
    await requireMatchingAuthSession(userId);
    let local = (await localWorkspace(userId)) || { user_id: userId };
    let planSyncedAt = null;
    if (local.planUnsynced) {
      // Older app versions queued plan changes offline. Plans are now set by
      // the server (trial or payment), so just refresh the real access state.
      const refreshed = await refreshAccessFromServer();
      if (!refreshed) throw new Error("Access status could not be refreshed.");
      local = {
        ...(await localWorkspace(userId)),
        requestedPlan: null,
        planUnsynced: false,
      };
      planSyncedAt = new Date().toISOString();
      await saveLocalWorkspace(local);
    }
    if (!local?.encrypted_data) {
      if (local.planUnsynced) {
        setSyncStatus("failed", local.last_synced_at);
        return;
      }
      setSyncStatus("synced", local.last_synced_at || planSyncedAt);
      return;
    }
    if (!local.unsynced) {
      const { data: latest, error } = await supabaseClient
        .from("biztrack_workspaces")
        .select(
          "encrypted_data, updated_at, salt, data_key_wrapped, recovery_key_wrapped",
        )
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      if (latest?.encrypted_data && !latest.data_key_wrapped) {
        if (!activeUser.legacyPasswordKey)
          throw new Error(
            "Legacy workspace requires a password login to finish safe key migration.",
          );
        const migrated = await migrateLegacyWorkspace({
          userId,
          email: activeUser.email,
          salt: latest.salt || activeUser.salt,
          passwordKey: activeUser.legacyPasswordKey,
          initialWorkspace: latest,
        });
        activeUser.key = migrated.dataKey;
        activeUser.dataKeyWrapped = migrated.dataKeyWrapped;
        activeUser.recoveryKeyWrapped = migrated.recoveryKeyWrapped;
        activeUser.legacyPasswordKey = null;
        showRecoveryCode(migrated.recoveryCode);
        local = await localWorkspace(userId);
        setSyncStatus("synced", local?.last_synced_at);
        if (
          document.querySelector(".app")?.classList.contains("hidden") === false
        ) {
          await loadBusinesses();
          const activeTab =
            document.querySelector(".nav-item.active")?.dataset.tab;
          if (activeTab === "overall") await loadOverallProfitLoss();
          else if (activeTab) loadTab(activeTab);
        }
        return;
      }
      if (latest?.encrypted_data && latest.updated_at !== local.updated_at) {
        await decryptPayload(latest.encrypted_data, activeUser.key);
        local = {
          ...local,
          encrypted_data: latest.encrypted_data,
          updated_at: latest.updated_at,
          salt: latest.salt || local.salt,
          data_key_wrapped: latest.data_key_wrapped || local.data_key_wrapped,
          recovery_key_wrapped:
            latest.recovery_key_wrapped || local.recovery_key_wrapped,
          last_synced_at: new Date().toISOString(),
          unsynced: false,
        };
        await saveLocalWorkspace(local);
        if (
          document.querySelector(".app")?.classList.contains("hidden") === false
        ) {
          await loadBusinesses();
          const activeTab =
            document.querySelector(".nav-item.active")?.dataset.tab;
          if (activeTab === "overall") await loadOverallProfitLoss();
          else if (activeTab) loadTab(activeTab);
        }
      }
      if (planSyncedAt) {
        local = { ...local, last_synced_at: planSyncedAt };
        await saveLocalWorkspace(local);
      }
      if (local.planUnsynced) {
        setSyncStatus(
          navigator.onLine ? "failed" : "offline",
          local.last_synced_at,
        );
        return;
      }
      setSyncStatus("synced", local.last_synced_at || planSyncedAt);
      return;
    }
    if (isReadOnly() && (activeUser.dataKeyWrapped || local.data_key_wrapped)) {
      setSyncStatus("failed", local.last_synced_at);
      showToast(
        "Your changes are saved on this device. They will sync after you renew your plan.",
        true,
      );
      return;
    }
    setSyncStatus("saving", local.last_synced_at);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data: remote, error: readError } = await supabaseClient
        .from("biztrack_workspaces")
        .select("encrypted_data, updated_at, salt")
        .eq("user_id", userId)
        .maybeSingle();
      if (readError) throw readError;
      let localStore = await decryptPayload(
        local.encrypted_data,
        activeUser.key,
      );
      if (remote?.encrypted_data && remote.updated_at !== local.updated_at) {
        const remoteStore = await decryptPayload(
          remote.encrypted_data,
          activeUser.key,
        );
        localStore = mergeWorkspaces(localStore, remoteStore);
        const encryptedMerged = await encryptStore(localStore);
        local = {
          ...local,
          encrypted_data: encryptedMerged,
          updated_at: remote.updated_at,
          unsynced: true,
        };
        await saveLocalWorkspace(local);
      }
      const nextUpdatedAt = new Date().toISOString();
      attemptedCiphertext = local.encrypted_data;
      const payload = {
        user_id: userId,
        salt: activeUser.salt,
        encrypted_data: local.encrypted_data,
        data_key_wrapped:
          activeUser.dataKeyWrapped || local.data_key_wrapped || null,
        recovery_key_wrapped:
          activeUser.recoveryKeyWrapped || local.recovery_key_wrapped || null,
        updated_at: nextUpdatedAt,
      };
      let result;
      if (remote?.updated_at) {
        result = await supabaseClient
          .from("biztrack_workspaces")
          .update(payload)
          .eq("user_id", userId)
          .eq("updated_at", remote.updated_at)
          .select("updated_at")
          .maybeSingle();
      } else {
        result = await supabaseClient
          .from("biztrack_workspaces")
          .insert(payload)
          .select("updated_at")
          .maybeSingle();
      }
      if (result.error) {
        if (result.error.code === "23505" || result.error.code === "PGRST116")
          continue;
        throw result.error;
      }
      if (!result.data) continue;
      const fresh = await localWorkspace(userId);
      if (fresh?.encrypted_data === local.encrypted_data) {
        const syncedAt = new Date().toISOString();
        await saveLocalWorkspace({
          ...fresh,
          updated_at: nextUpdatedAt,
          last_synced_at: syncedAt,
          unsynced: false,
        });
        activeUser.workspaceUpdatedAt = nextUpdatedAt;
        syncRetryDelay = 10000;
        setSyncStatus("synced", syncedAt);
      }
      return;
    }
    // An update that matches no row is how the database answers when write
    // access has ended. Confirm before retrying forever.
    if (await refreshAccessFromServer()) {
      if (isReadOnly()) {
        const denied = new Error("Write access has ended.");
        denied.code = "42501";
        throw denied;
      }
    }
    throw new Error("Workspace changed repeatedly while syncing.");
  } catch (error) {
    failed = true;
    console.warn("Workspace sync deferred:", error);
    const latest = await localWorkspace(userId);
    const accessDenied = error?.code === "42501" || error?.status === 403;
    syncNeedsLogin = error?.status === 401;
    setSyncStatus(
      syncNeedsLogin ? "auth" : navigator.onLine ? "failed" : "offline",
      latest?.last_synced_at,
    );
    if (syncNeedsLogin) {
      showToast(
        "Your session expired. Log in to sync; local changes are safe.",
        true,
      );
    } else if (accessDenied) {
      refreshAccessBanner();
      showToast(
        "Your encrypted changes remain on this device. They can sync after payment restores write access.",
        true,
      );
    } else if (navigator.onLine) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => syncWorkspace(), syncRetryDelay);
      syncRetryDelay = Math.min(syncRetryDelay * 2, 120000);
    }
  } finally {
    syncInProgress = false;
    const pending = await localWorkspace(userId).catch(() => null);
    if (
      !failed &&
      pending?.unsynced &&
      pending.encrypted_data !== attemptedCiphertext &&
      navigator.onLine
    )
      queueWorkspaceSync();
  }
};
document
  .getElementById("sync-now-button")
  ?.addEventListener("click", async () => {
    if (syncNeedsLogin) {
      document.querySelector(".app").classList.add("hidden");
      document.getElementById("auth-screen").classList.remove("hidden");
      showAuthPanel(false);
      authMessage(
        "Log in to sync. Your encrypted changes remain saved on this device.",
      );
      document.querySelector('#login-form input[name="email"]').value =
        activeUser?.email || "";
      return;
    }
    await syncWorkspace();
    const local = activeUser ? await localWorkspace(activeUser.id) : null;
    if (local && !local.unsynced) showToast("Workspace synced.");
  });
window.addEventListener("online", async () => {
  if (activeUser && supabaseClient) {
    try {
      await supabaseClient.auth.refreshSession();
    } catch {
      // Local work remains available when the cached server session expires.
    }
    await syncWorkspace();
    await loadPaymentStatuses();
  }
});
const syncAfterResume = async () => {
  if (!activeUser || !supabaseClient) return;
  try {
    await supabaseClient.auth.refreshSession();
  } catch {
    // Local work remains available when the cached server session expires.
  }
  await syncWorkspace();
  await loadPaymentStatuses();
};
window.addEventListener("offline", async () => {
  const local = activeUser ? await localWorkspace(activeUser.id) : null;
  setSyncStatus("offline", local?.last_synced_at);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") markActive(true);
  if (document.visibilityState === "visible") syncWorkspace();
});
const saveProfile = async ({ id, email, name }) => {
  if (!supabaseClient) throw new Error("Supabase is not configured.");
  const { error } = await supabaseClient.from("biztrack_profiles").upsert(
    {
      user_id: id,
      email,
      name: String(name || "").trim(),
      updated_at: new Date().toISOString(),
    },
    // Only creates the profile the first time. Edits made in the Profile
    // screen are never overwritten by logging in again.
    { onConflict: "user_id", ignoreDuplicates: true },
  );
  if (error) throw error;
};
const planAllowed = (page) => {
  if (isReadOnly()) return true;
  const plan = accessState().plan;
  const current = PLAN_CONFIG[plan]?.pages || PLAN_CONFIG.basic.pages;
  return current.includes(page);
};
const ensurePlanAccess = (tab) => {
  if (isReadOnly()) return true;
  if (tab === "news" && !planAllowed("news")) return false;
  if (tab === "sales" && !planAllowed("sales")) return false;
  if (tab === "inventory" && !planAllowed("inventory")) return false;
  if (tab === "dashboard" && !planAllowed("dashboard")) return false;
  return true;
};
const nextId = () => crypto.randomUUID();
const requestData = (opts) => (opts?.body ? JSON.parse(opts.body) : {});
const requireBusiness = () => {
  if (!currentBusinessId) throw new Error("Select a business first.");
  return String(currentBusinessId);
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
  if (method !== "GET") requireWriteAccess();
  const data = requestData(opts);
  const store = await readStore();
  const businessId = String(currentBusinessId);
  const scoped = (rows) =>
    rows.filter((row) => String(row.business_id) === businessId);
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
      id: nextId(),
      name,
      business_type: String(data.business_type || "").trim(),
      created_at: new Date().toISOString(),
    };
    store.businesses.push(business);
    await save();
    return { ok: true, business };
  }
  const businessMatch = route.match(/^\/businesses\/([^/]+)$/);
  if (businessMatch) {
    const id = businessMatch[1];
    const business = store.businesses.find((row) => String(row.id) === id);
    if (!business) throw new Error("Business not found.");
    if (method === "PATCH") {
      const name = String(data.name || "").trim();
      if (!name) throw new Error("Business name is required.");
      if (
        store.businesses.some(
          (row) =>
            String(row.id) !== String(id) &&
            row.name.toLowerCase() === name.toLowerCase(),
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
        store[key] = store[key].filter((row) => String(row.business_id) !== id);
      });
      store.businesses = store.businesses.filter(
        (row) => String(row.id) !== id,
      );
      await save();
      return { ok: true };
    }
  }
  if (route === "/overall-profit-loss") {
    const businesses = store.businesses.map((business) => {
      const rows = store.transactions.filter(
        (row) => String(row.business_id) === String(business.id),
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
        id: nextId(),
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
        id: nextId(),
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
          id: nextId(),
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
  const stockMatch = route.match(/^\/products\/([^/]+)\/stock$/);
  if (stockMatch) {
    const product = store.products.find(
      (row) =>
        String(row.id) === stockMatch[1] && String(row.business_id) === id,
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
      id: nextId(),
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
        id: nextId(),
        business_id: id,
        product_id: data.product_id,
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
          .filter((row) => String(row.product_id) === String(product.id))
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
          id: nextId(),
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
        id: nextId(),
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
          id: nextId(),
          business_id: id,
          product_id: product.id,
          change_qty: -qty,
          occurred_at: invoice.created_at,
        });
      }
      if (invoice.status === "paid")
        store.transactions.push({
          id: nextId(),
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
          store.customers.find(
            (row) => String(row.id) === String(invoice.customer_id),
          )?.name || "Customer",
        product_name:
          invoice.product_name ||
          store.products.find(
            (row) => String(row.id) === String(invoice.product_id),
          )?.name ||
          "Product",
        total: invoice.qty * invoice.unit_price,
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  const paidMatch = route.match(/^\/invoices\/([^/]+)\/mark-paid$/);
  if (paidMatch) {
    const invoice = scoped(store.invoices).find(
      (row) => String(row.id) === paidMatch[1],
    );
    if (!invoice) throw new Error("Invoice not found.");
    if (invoice.status !== "paid") {
      invoice.status = "paid";
      store.transactions.push({
        id: nextId(),
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
        const product = products.find(
          (row) => String(row.id) === String(invoice.product_id),
        );
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
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(today.getDate()).padStart(2, "0")}`;
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
const drawerBackdrop = document.querySelector(".drawer-backdrop");
const mobilePageTitle = document.getElementById("mobile-page-title");
let currentTab = "businesses";
const tabHistory = [];
const closeMobileMenu = () => {
  if (!sidebar?.classList.contains("open")) return;
  sidebar.classList.remove("open");
  document.body.classList.remove("menu-open");
  mobileMenuButton?.setAttribute("aria-expanded", "false");
  mobileMenuButton?.setAttribute("aria-label", "Open menu");
  mobileMenuButton?.focus();
};
const openMobileMenu = () => {
  if (!sidebar || window.innerWidth > 900) return;
  sidebar.classList.add("open");
  document.body.classList.add("menu-open");
  mobileMenuButton?.setAttribute("aria-expanded", "true");
  mobileMenuButton?.setAttribute("aria-label", "Close menu");
  sidebar.querySelector(".nav-item:not([hidden])")?.focus();
};
const activateTab = (tab, fromBackButton = false) => {
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
  if (isNativeApp && tab !== currentTab) {
    if (fromBackButton) tabHistory.pop();
    else tabHistory.push(currentTab);
    currentTab = tab;
  }
  if (mobilePageTitle) {
    const activeNav = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    mobilePageTitle.textContent = activeNav?.textContent.trim() || "BizTrack";
  }
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
drawerBackdrop?.addEventListener("click", closeMobileMenu);
window.addEventListener("resize", () => {
  if (window.innerWidth > 900) {
    sidebar?.classList.remove("open");
    document.body.classList.remove("menu-open");
    mobileMenuButton?.setAttribute("aria-expanded", "false");
    mobileMenuButton?.setAttribute("aria-label", "Open menu");
  }
});
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
          `<option value="${business.id}">${escapeHtml(
            business.name,
          )}</option>`,
      )
      .join("");
  select.value = currentBusinessId;
  document.getElementById("business-list").innerHTML = businesses.length
    ? businesses
        .map(
          (business) =>
            `<button class="business-row${
              String(business.id) === String(currentBusinessId)
                ? " selected"
                : ""
            }" data-business-id="${business.id}"><strong>${escapeHtml(
              business.name,
            )}</strong><span>${escapeHtml(
              business.business_type || "Business",
            )}</span></button>`,
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
    closeMobileMenu();
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
        `Delete ${
          business?.name || "this business"
        } and all of its records? This cannot be undone.`,
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
  document.getElementById("reset-panel")?.classList.add("hidden");
  authMessage();
};
const beginSession = async (account, key) => {
  const savedLocal = await localWorkspace(account.id);
  activeUser = {
    id: account.id,
    key,
    salt: account.salt,
    email: account.email || "",
    session: account.session || null,
    plan: account.plan || savedLocal?.plan || "basic",
    trialEndsAt: account.trialEndsAt || savedLocal?.trialEndsAt || null,
    planExpiresAt: account.planExpiresAt || savedLocal?.planExpiresAt || null,
    trialMode: account.trialMode === true || savedLocal?.trialMode === true,
    legacyPasswordKey: account.legacyPasswordKey || null,
    dataKeyWrapped: account.dataKeyWrapped || null,
    recoveryKeyWrapped: account.recoveryKeyWrapped || null,
  };
  activePlan = account.plan || "";
  await saveLocalWorkspace({
    ...(savedLocal || {}),
    user_id: account.id,
    email: account.email || savedLocal?.email || "",
    salt: account.salt,
    cachedKey: key,
    legacyPasswordKey:
      account.legacyPasswordKey || savedLocal?.legacyPasswordKey || null,
    data_key_wrapped:
      account.dataKeyWrapped || savedLocal?.data_key_wrapped || null,
    recovery_key_wrapped:
      account.recoveryKeyWrapped || savedLocal?.recovery_key_wrapped || null,
    plan: activePlan || savedLocal?.plan || "",
    trialEndsAt: activeUser.trialEndsAt || savedLocal?.trialEndsAt || null,
    trialMode: activeUser.trialMode,
    planExpiresAt: activeUser.planExpiresAt,
  });
  activePlan ||= savedLocal?.plan || "";
  const state = accessState();
  activePlan = state.plan;
  resetInactivityTimer();
  setSyncStatus(
    savedLocal?.unsynced
      ? navigator.onLine
        ? "pending"
        : "offline"
      : savedLocal?.last_synced_at
      ? "synced"
      : "none",
    savedLocal?.last_synced_at,
  );
  const businessKey = getBusinessStorageKey(account.id);
  currentBusinessId =
    localStorage.getItem(businessKey) ||
    localStorage.getItem("biztrack-business-id") ||
    "";
  if (currentBusinessId) localStorage.setItem(businessKey, currentBusinessId);
  localStorage.removeItem("biztrack-business-id");
  document.getElementById("auth-screen").classList.add("hidden");
  // Read-only accounts with data still open the app (view and export).
  if (
    state.access !== "read_only" ||
    savedLocal?.encrypted_data ||
    account.hasWorkspace
  ) {
    document.getElementById("plan-screen").classList.add("hidden");
    document.querySelector(".app").classList.remove("hidden");
    document.getElementById("account-plan").textContent =
      PLAN_CONFIG[activePlan]?.name || "BizTrack Basic";
    updatePlanUI();
    refreshAccessBanner();
    loadPaymentStatuses();
    loadProfile();
    await loadBusinesses();
    resetInactivityTimer();
    syncWorkspace();
  } else {
    document.querySelector(".app").classList.add("hidden");
    document.getElementById("plan-screen").classList.remove("hidden");
    showPlanSelection();
  }
};
const openWorkspaceFromLocal = async () => {
  loadProfile();
  document.getElementById("lock-screen").classList.add("hidden");
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("plan-screen").classList.add("hidden");
  document.querySelector(".app").classList.remove("hidden");
  document.getElementById("account-plan").textContent =
    PLAN_CONFIG[activePlan]?.name || "BizTrack Basic";
  updatePlanUI();
  refreshAccessBanner();
  await loadBusinesses();
  resetInactivityTimer();
};
const showPlanSelection = () => {
  if (!document.getElementById("plan-screen")) return;
  const state = accessState();
  const status = document.getElementById("plan-access-status");
  if (status) {
    status.textContent =
      state.access === "read_only"
        ? "Your workspace is read-only. Choose a plan to restore editing."
        : `${
            state.access === "trial"
              ? "Basic trial"
              : PLAN_CONFIG[state.plan]?.name || "Plan"
          }: ${timeLeftLabel(state.expiresAt)} (ends ${shortDate(
            state.expiresAt,
          )}).`;
  }
  const cards = document.querySelectorAll("[data-plan-card]");
  cards.forEach((card) => {
    const code = card.dataset.planCard;
    card.classList.toggle("selected", activePlan === code);
    const choice = card.querySelector(".plan-choice");
    if (!choice) return;
    const price = PLAN_CONFIG[code].priceLabel.replace(" / month", "");
    const current = state.access !== "read_only" && state.plan === code;
    if (code === "basic" && !activeUser?.trialEndsAt)
      choice.textContent = "Start 7-day free trial";
    else if (code === "basic" && state.access !== "read_only")
      choice.textContent = "Continue";
    else choice.textContent = current ? `Renew · ${price}` : `Pay ${price}`;
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
  refreshAccessBanner();
};
const refreshAccessBanner = () => {
  const banner = document.getElementById("access-banner");
  if (!banner || !activeUser) return;
  const state = accessState();
  const ended = state.access === "read_only";
  clearTimeout(accessExpiryTimer);
  if (state.expiresAt) {
    accessExpiryTimer = setTimeout(
      () => updatePlanUI(),
      Math.min(Math.max(state.expiresAt - Date.now() + 50, 0), 2147480000),
    );
  }
  // Active Premium: nothing to upgrade to, so no banner at all.
  // Active Basic or Pro: one slim line with an Upgrade button.
  // Ended: the full notice with Pay and Export.
  const premiumActive = !ended && state.plan === "premium";
  banner.classList.toggle("hidden", premiumActive);
  banner.classList.toggle("compact", !ended);
  banner.classList.toggle("ended", ended);
  const message = document.getElementById("access-banner-message");
  const days = document.getElementById("access-days-left");
  if (message) {
    message.textContent = ended
      ? "Your free trial / plan has ended. Your data is safe. Pay to continue adding records."
      : state.access === "trial"
      ? "Basic trial"
      : PLAN_CONFIG[state.plan]?.name.replace("BizTrack ", "") || "Your plan";
  }
  if (days) {
    days.textContent = ended
      ? "Your workspace is read-only."
      : `${timeLeftLabel(state.expiresAt)} · ends ${shortDate(state.expiresAt)}`;
  }
  const payButton = document.getElementById("access-pay-button");
  if (payButton) payButton.textContent = ended ? "Pay" : "Upgrade";
  document
    .querySelectorAll(
      "#business-form, #rename-business-form, #txn-form, #product-form, #market-form, #invoice-form",
    )
    .forEach((form) => {
      form
        .querySelectorAll("input, select, textarea, button")
        .forEach((control) => {
          control.disabled = ended;
        });
    });
  ["invoice-submit", "product-submit", "market-submit"].forEach((id) => {
    const control = document.getElementById(id);
    if (control) control.disabled = ended;
  });
  document
    .querySelectorAll(
      "#product-list button, #invoice-list button, #business-context-menu button",
    )
    .forEach((control) => {
      control.disabled = ended;
    });
};
setInterval(() => {
  if (activeUser && document.visibilityState === "visible") refreshAccessBanner();
}, 60000);
const exportWorkspace = async () => {
  const store = await readStore();
  const blob = new Blob(
    [
      JSON.stringify(
        { exportedAt: new Date().toISOString(), data: store },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `biztrack-export-${new Date()
    .toISOString()
    .slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
};
// ---------------------------------------------------------------------------
// Automatic mobile money payments (MTN / Airtel via Relworx).
// The user enters their number, approves the prompt on their phone with
// their PIN, and the plan unlocks as soon as the server confirms it.
// ---------------------------------------------------------------------------
const PAYMENT_POLL_MS = 4000;
const PAYMENT_WAIT_MS = 3 * 60 * 1000;
let paymentPollTimer;
let paymentPollStarted = 0;
const PHONE_KEY = "biztrack-payment-phone";
const ugandaNetwork = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  const local = digits.startsWith("256")
    ? digits.slice(3)
    : digits.startsWith("0")
    ? digits.slice(1)
    : digits;
  if (/^7[678]/.test(local) || /^39/.test(local)) return "MTN";
  if (/^7[045]/.test(local) || /^20/.test(local)) return "Airtel";
  return "";
};
const paymentElements = () => ({
  dialog: document.getElementById("payment-dialog"),
  form: document.getElementById("payment-form"),
  summary: document.getElementById("payment-summary"),
  phone: document.getElementById("payment-phone"),
  network: document.getElementById("payment-network"),
  message: document.getElementById("payment-form-message"),
  submit: document.getElementById("payment-submit"),
  cancel: document.getElementById("payment-cancel"),
  waiting: document.getElementById("payment-waiting"),
});
const setPaymentStage = (stage, text = "", isError = false) => {
  const el = paymentElements();
  el.form.dataset.stage = stage;
  const entering = stage === "enter";
  el.phone.disabled = !entering;
  el.submit.disabled = !entering;
  el.submit.textContent = entering ? "Pay now" : "Waiting…";
  el.waiting.classList.toggle("hidden", stage !== "waiting");
  el.cancel.textContent = stage === "waiting" ? "Close" : "Cancel";
  el.message.textContent = text;
  el.message.classList.toggle("error", isError);
};
const formatDate = (iso) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";
const openPaymentDialog = (plan = "pro") => {
  const config = PLAN_CONFIG[plan] || PLAN_CONFIG.pro;
  const el = paymentElements();
  clearTimeout(paymentPollTimer);
  el.dialog.dataset.plan = config.id;
  el.summary.textContent = `${config.name}: ${config.priceLabel.replace(
    " / month",
    "",
  )} for 30 days.`;
  try {
    el.phone.value = localStorage.getItem(PHONE_KEY) || "";
  } catch {
    el.phone.value = "";
  }
  el.network.textContent = ugandaNetwork(el.phone.value);
  setPaymentStage("enter");
  el.dialog.classList.remove("hidden");
  el.phone.focus();
};
const closePaymentDialog = () => {
  clearTimeout(paymentPollTimer);
  paymentElements().dialog.classList.add("hidden");
};
// After a successful payment: make sure the user lands in a usable workspace.
const enterWorkspace = async () => {
  document.getElementById("plan-screen").classList.add("hidden");
  document.querySelector(".app").classList.remove("hidden");
  updatePlanUI();
  const local = activeUser ? await localWorkspace(activeUser.id) : null;
  // Brand-new accounts need an empty workspace. Never create one if this
  // account already has data online (e.g. logging in on a new phone).
  if (activeUser && !local?.encrypted_data && !isReadOnly() && navigator.onLine) {
    const { data: existing, error } = await supabaseClient
      .from("biztrack_workspaces")
      .select("user_id")
      .eq("user_id", activeUser.id)
      .maybeSingle();
    if (!error && !existing) await writeStore(emptyStore());
  }
  await loadBusinesses();
  refreshAccessBanner();
  syncWorkspace();
};
const handlePaymentResult = async (payment, access) => {
  if (payment.status === "verified") {
    clearTimeout(paymentPollTimer);
    await applyAccess(access);
    closePaymentDialog();
    await enterWorkspace();
    showToast(
      `${PLAN_CONFIG[payment.plan]?.name || "Your plan"} is active until ${formatDate(
        access?.planExpiresAt,
      )}. Thank you!`,
    );
    loadPaymentStatuses();
    return true;
  }
  if (payment.status === "failed") {
    clearTimeout(paymentPollTimer);
    setPaymentStage(
      "enter",
      `Payment not completed: ${
        payment.failureReason || "it was declined or cancelled"
      }. You can try again.`,
      true,
    );
    loadPaymentStatuses();
    return true;
  }
  return false;
};
const pollPayment = async (reference) => {
  clearTimeout(paymentPollTimer);
  if (Date.now() - paymentPollStarted > PAYMENT_WAIT_MS) {
    setPaymentStage(
      "timeout",
      "We're still waiting for your network to confirm. If you approved it, your plan will unlock automatically. You can close this window.",
    );
    loadPaymentStatuses();
    return;
  }
  try {
    const result = await invokeFunction("payments", {
      action: "status",
      reference,
    });
    if (await handlePaymentResult(result.payment, result.access)) return;
  } catch (error) {
    console.warn("Payment status check failed:", error);
  }
  paymentPollTimer = setTimeout(() => pollPayment(reference), PAYMENT_POLL_MS);
};
const startPayment = async () => {
  const el = paymentElements();
  const plan = el.dialog.dataset.plan;
  const phone = el.phone.value.trim();
  if (!navigator.onLine) {
    setPaymentStage("enter", "You're offline. Connect to the internet to pay.", true);
    return;
  }
  setPaymentStage("sending", "Sending the payment request to your phone…");
  try {
    const result = await invokeFunction("payments", {
      action: "create",
      plan,
      phone,
    });
    try {
      localStorage.setItem(PHONE_KEY, phone);
    } catch {
      // Remembering the number is only a convenience.
    }
    setPaymentStage(
      "waiting",
      `Check your phone and enter your ${
        ugandaNetwork(phone) || "Mobile Money"
      } PIN to approve UGX ${Number(result.payment.amount).toLocaleString()}.`,
    );
    paymentPollStarted = Date.now();
    paymentPollTimer = setTimeout(
      () => pollPayment(result.payment.reference),
      PAYMENT_POLL_MS,
    );
  } catch (error) {
    if (error.status === 409 && error.payload?.payment?.reference) {
      setPaymentStage("waiting", error.message);
      paymentPollStarted = Date.now();
      pollPayment(error.payload.payment.reference);
      return;
    }
    setPaymentStage("enter", error.message, true);
  }
};
// Shows recent payments and finishes any that completed while the app was
// closed (the server re-checks pending ones with the provider).
const loadPaymentStatuses = async () => {
  if (!activeUser || !navigator.onLine || !supabaseClient) return;
  let payments = [];
  try {
    payments = (await invokeFunction("payments", { action: "list" })).payments || [];
  } catch {
    return;
  }
  for (const payment of payments.filter((p) => p.status === "pending")) {
    try {
      const result = await invokeFunction("payments", {
        action: "status",
        reference: payment.reference,
      });
      Object.assign(payment, result.payment);
      if (result.payment.status === "verified") {
        await applyAccess(result.access);
        showToast(
          `${PLAN_CONFIG[payment.plan]?.name || "Your plan"} is active until ${formatDate(
            result.access?.planExpiresAt,
          )}.`,
        );
      }
    } catch {
      // Leave it pending; the webhook or the next check will settle it.
    }
  }
  const statusList = document.getElementById("payment-status-list");
  if (statusList) {
    const labels = { verified: "paid", failed: "not completed", pending: "waiting" };
    statusList.textContent = payments
      .slice(0, 3)
      .map(
        (p) =>
          `${formatDate(p.createdAt)} · ${
            PLAN_CONFIG[p.plan]?.name || p.plan
          } · ${labels[p.status] || p.status}`,
      )
      .join("\n");
  }
};
document.getElementById("export-data-button")?.addEventListener("click", () => {
  exportWorkspace().catch((error) => showToast(error.message, true));
});
document.getElementById("access-pay-button")?.addEventListener("click", () => {
  document.querySelector(".app").classList.add("hidden");
  document.getElementById("plan-screen").classList.remove("hidden");
  showPlanSelection();
});
document.getElementById("payment-cancel")?.addEventListener("click", () => {
  closePaymentDialog();
});
document.getElementById("payment-phone")?.addEventListener("input", (event) => {
  paymentElements().network.textContent = ugandaNetwork(event.target.value);
});
document
  .getElementById("payment-form")
  ?.addEventListener("submit", (event) => {
    event.preventDefault();
    startPayment();
  });
// ---------------------------------------------------------------------------
// Profile: name, username, photo, phone, town and a short bio.
// Stored in biztrack_profiles (not encrypted, unlike business records), and
// cached on the device so the menu shows it offline.
// ---------------------------------------------------------------------------
const PROFILE_FIELDS = "name, username, email, phone, location, bio, avatar_url";
let currentProfile = null;
let pendingAvatar; // undefined = unchanged, null = removed, string = new photo
const profileCacheKey = (userId) => `biztrack-profile-${userId}`;
const initials = (text) =>
  String(text || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "?";
const paintAvatar = (element, photo, label) => {
  if (!element) return;
  if (photo) {
    element.style.backgroundImage = `url("${photo}")`;
    element.textContent = "";
  } else {
    element.style.backgroundImage = "";
    element.textContent = initials(label);
  }
};
const renderProfileChip = () => {
  const profile = currentProfile || {};
  const name = profile.name || activeUser?.email || "Your profile";
  paintAvatar(document.getElementById("profile-chip-avatar"), profile.avatar_url, name);
  const nameEl = document.getElementById("profile-chip-name");
  const userEl = document.getElementById("profile-chip-username");
  if (nameEl) nameEl.textContent = name;
  if (userEl)
    userEl.textContent = profile.username
      ? `@${profile.username}`
      : "Add your details";
};
const loadProfile = async () => {
  if (!activeUser) return;
  const userId = activeUser.id;
  try {
    currentProfile = JSON.parse(localStorage.getItem(profileCacheKey(userId)) || "null");
  } catch {
    currentProfile = null;
  }
  renderProfileChip();
  if (!navigator.onLine || !supabaseClient) return;
  const { data, error } = await supabaseClient
    .from("biztrack_profiles")
    .select(PROFILE_FIELDS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data || activeUser?.id !== userId) return;
  currentProfile = data;
  try {
    localStorage.setItem(profileCacheKey(userId), JSON.stringify(data));
  } catch {
    // A large photo may not fit; the menu falls back to initials offline.
  }
  renderProfileChip();
};
// Shrinks a chosen photo to a 256 px square JPEG (about 20–40 KB).
const resizePhoto = async (file) => {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > 15 * 1024 * 1024) throw new Error("That photo is too large. Choose one under 15 MB.");
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  canvas
    .getContext("2d")
    .drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      256,
      256,
    );
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", 0.82);
};
const profileEl = (id) => document.getElementById(`profile-${id}`);
const openProfileDialog = () => {
  if (!activeUser) return;
  if (typeof closeMobileMenu === "function") closeMobileMenu();
  const profile = currentProfile || {};
  pendingAvatar = undefined;
  profileEl("name").value = profile.name || "";
  profileEl("username").value = profile.username || "";
  profileEl("email").value = profile.email || activeUser.email || "";
  profileEl("phone").value = profile.phone || "";
  profileEl("location").value = profile.location || "";
  profileEl("bio").value = profile.bio || "";
  profileEl("message").textContent = "";
  profileEl("message").classList.remove("error");
  paintAvatar(profileEl("avatar-preview"), profile.avatar_url, profile.name || activeUser.email);
  profileEl("dialog").classList.remove("hidden");
  profileEl("name").focus();
};
const closeProfileDialog = () => profileEl("dialog").classList.add("hidden");
const profileError = (text) => {
  profileEl("message").textContent = text;
  profileEl("message").classList.add("error");
};
document.getElementById("profile-button")?.addEventListener("click", openProfileDialog);
document.getElementById("profile-cancel")?.addEventListener("click", closeProfileDialog);
document.getElementById("profile-photo-input")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    pendingAvatar = await resizePhoto(file);
    paintAvatar(profileEl("avatar-preview"), pendingAvatar, profileEl("name").value);
    profileEl("message").textContent = "";
  } catch (error) {
    profileError(error.message || "That photo could not be used.");
  }
});
document.getElementById("profile-photo-remove")?.addEventListener("click", () => {
  pendingAvatar = null;
  paintAvatar(profileEl("avatar-preview"), null, profileEl("name").value || activeUser?.email);
});
document.getElementById("profile-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeUser) return;
  const name = profileEl("name").value.trim();
  const username = profileEl("username").value.trim().replace(/^@/, "").toLowerCase();
  if (!name) return profileError("Enter your name.");
  if (username && !/^[a-z0-9_.]{3,30}$/.test(username))
    return profileError("Usernames use 3–30 letters, numbers, dots or underscores, with no spaces.");
  if (!navigator.onLine || !supabaseClient)
    return profileError("Connect to the internet to save your profile.");
  const changes = {
    name,
    username: username || null,
    phone: profileEl("phone").value.trim() || null,
    location: profileEl("location").value.trim() || null,
    bio: profileEl("bio").value.trim() || null,
    updated_at: new Date().toISOString(),
  };
  if (pendingAvatar !== undefined) changes.avatar_url = pendingAvatar;
  const saveButton = profileEl("save");
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";
  try {
    const { data, error } = await supabaseClient
      .from("biztrack_profiles")
      .update(changes)
      .eq("user_id", activeUser.id)
      .select(PROFILE_FIELDS)
      .maybeSingle();
    if (error) {
      if (error.code === "23505") throw new Error("That username is already taken. Try another.");
      if (error.code === "23514") throw new Error("Please check your details: one of them is too long or not allowed.");
      if (error.code === "42501" || error.code === "42703")
        throw new Error("Profiles aren't switched on yet. Please try again later.");
      throw new Error("Your profile could not be saved. Try again.");
    }
    if (!data) throw new Error("Your profile could not be saved. Log in again and retry.");
    currentProfile = data;
    try {
      localStorage.setItem(profileCacheKey(activeUser.id), JSON.stringify(data));
    } catch {
      // Not cached; it reloads next time online.
    }
    supabaseClient.auth.updateUser({ data: { name } }).catch(() => {});
    renderProfileChip();
    closeProfileDialog();
    showToast("Profile saved.");
  } catch (error) {
    profileError(error.message);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save profile";
  }
});
// ---------------------------------------------------------------------------
// Forgot password. Business data is encrypted, so a new password alone can't
// open it: the recovery code unwraps the data key, which is then wrapped
// again with the new password.
// ---------------------------------------------------------------------------
const unwrapRawKey = async (wrapped, wrappingKey) => {
  const payload = JSON.parse(wrapped);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
    wrappingKey,
    base64ToBytes(payload.data),
  );
};
const showResetPanel = () => {
  document.getElementById("auth-screen").classList.remove("hidden");
  document.getElementById("login-panel").classList.add("hidden");
  document.getElementById("signup-panel").classList.add("hidden");
  document.getElementById("reset-panel").classList.remove("hidden");
  authMessage();
  document.getElementById("reset-password").focus();
};
if (openedFromResetLink) showResetPanel();
supabaseClient?.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") showResetPanel();
});
document.getElementById("forgot-password")?.addEventListener("click", async () => {
  const email = document
    .querySelector('#login-form input[name="email"]')
    .value.trim()
    .toLowerCase();
  if (!email) return authMessage("Enter your email above, then tap Forgot password.");
  if (!navigator.onLine || !supabaseClient)
    return authMessage("Connect to the internet to reset your password.");
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: "https://allanorabaasa-hash.github.io/biztrack/",
  });
  authMessage(
    error
      ? "Could not send the reset email. Wait a minute and try again."
      : "If that email has an account, a reset link is on its way. Open it on any device, and have your recovery code ready.",
  );
});
document.getElementById("reset-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const password = String(form.password.value);
  const code = String(form.code.value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (password.length < 10) return authMessage("Use a password with at least 10 characters.");
  submit.disabled = true;
  try {
    const {
      data: { session },
    } = await supabaseClient.auth.getSession();
    if (!session) throw new Error("This reset link has expired. Request a new one from the login screen.");
    const user = session.user;
    const { data: workspace, error: readError } = await supabaseClient
      .from("biztrack_workspaces")
      .select("salt, data_key_wrapped, recovery_key_wrapped")
      .eq("user_id", user.id)
      .maybeSingle();
    if (readError) throw new Error("Could not load your account. Check your connection and try again.");
    let newWrapped = null;
    if (workspace?.data_key_wrapped) {
      if (!code) throw new Error("Enter the recovery code you saved when you created your account.");
      if (!workspace.recovery_key_wrapped)
        throw new Error("This account has no recovery code saved. Contact support.");
      const recovery = JSON.parse(workspace.recovery_key_wrapped);
      let rawKey;
      try {
        rawKey = await unwrapRawKey(recovery.wrapped, (await deriveKey(code, recovery.salt)).key);
      } catch {
        throw new Error("That recovery code is not correct. Check it and try again.");
      }
      const salt = workspace.salt || user.user_metadata?.salt;
      newWrapped = await wrapRawKey(rawKey, (await deriveKey(password, salt)).key);
      const { error: keyError } = await supabaseClient.rpc("biztrack_set_password_key", {
        p_wrapped: newWrapped,
      });
      if (keyError) throw new Error("Could not update your data key. Try again.");
    } else if (workspace) {
      throw new Error("This older account needs your old password. Contact support.");
    }
    const { error: passwordError } = await supabaseClient.auth.updateUser({ password });
    if (passwordError) {
      if (newWrapped && workspace?.data_key_wrapped)
        await supabaseClient.rpc("biztrack_set_password_key", {
          p_wrapped: workspace.data_key_wrapped,
        });
      throw new Error(passwordError.message || "Could not change your password.");
    }
    const local = await localWorkspace(user.id);
    if (local && newWrapped) await saveLocalWorkspace({ ...local, data_key_wrapped: newWrapped });
    clearActiveMarker();
    await supabaseClient.auth.signOut({ scope: "local" });
    history.replaceState(null, "", window.location.pathname);
    form.reset();
    showAuthPanel(false);
    const loginEmail = document.querySelector('#login-form input[name="email"]');
    if (loginEmail) loginEmail.value = user.email || "";
    authMessage("Password changed. Log in with your new password.");
  } catch (error) {
    authMessage(error.message);
  } finally {
    submit.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Delete my account (required by Google Play).
// ---------------------------------------------------------------------------
const deleteEl = (id) => document.getElementById(`delete-${id}`);
const resetToLoggedOut = () => {
  activeUser = null;
  activePlan = "";
  currentBusinessId = "";
  currentProfile = null;
  renderProfileChip();
  document.querySelector(".app").classList.add("hidden");
  document.getElementById("plan-screen").classList.add("hidden");
  document.getElementById("auth-screen").classList.remove("hidden");
  showAuthPanel(false);
};
document.getElementById("delete-account-open")?.addEventListener("click", () => {
  closeProfileDialog();
  deleteEl("form").reset();
  deleteEl("message").textContent = "";
  deleteEl("dialog").classList.remove("hidden");
  deleteEl("password").focus();
});
deleteEl("cancel")?.addEventListener("click", () => deleteEl("dialog").classList.add("hidden"));
deleteEl("export")?.addEventListener("click", () =>
  exportWorkspace().catch((error) => showToast(error.message, true)),
);
deleteEl("form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeUser) return;
  const message = deleteEl("message");
  if (deleteEl("confirm").value.trim().toUpperCase() !== "DELETE")
    return (message.textContent = "Type DELETE to confirm.");
  if (!navigator.onLine || !supabaseClient)
    return (message.textContent = "Connect to the internet to delete your account.");
  const submit = deleteEl("submit");
  submit.disabled = true;
  submit.textContent = "Deleting…";
  const userId = activeUser.id;
  try {
    // Confirm it's really the owner: sign in again with the password.
    const { error: authError } = await supabaseClient.auth.signInWithPassword({
      email: activeUser.email,
      password: deleteEl("password").value,
    });
    if (authError) throw new Error("That password is not correct.");
    await invokeFunction("delete-account", { confirm: "DELETE" });
    await removeLocalWorkspace(userId);
    for (const key of [
      profileCacheKey(userId),
      getBusinessStorageKey(userId),
      PHONE_KEY,
    ]) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Nothing stored.
      }
    }
    clearActiveMarker();
    await supabaseClient.auth.signOut({ scope: "local" }).catch(() => {});
    deleteEl("dialog").classList.add("hidden");
    resetToLoggedOut();
    showToast("Your account and all its data have been deleted.");
  } catch (error) {
    message.textContent = error.message || "Your account could not be deleted.";
  } finally {
    submit.disabled = false;
    submit.textContent = "Delete forever";
  }
});
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
      if (!navigator.onLine)
        throw new Error("Connect to the internet for first-time signup.");
      if (!supabaseClient) throw new Error("Supabase is not configured.");
      const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
      const passwordKeys = await deriveKey(password, salt);
      const keyBundle = await createDataKeyBundle(passwordKeys.key);
      const { data, error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: authRedirectUrl,
          data: { name: String(values.name).trim(), salt },
        },
      });
      if (error) throw error;
      if (!data.user || !data.session) {
        // Email confirmation is on: the account is set up on first login.
        showAuthPanel(false);
        const loginEmail = document.querySelector('#login-form input[name="email"]');
        if (loginEmail) loginEmail.value = email;
        return authMessage(
          "Account created. Check your email and tap the confirmation link, then log in here.",
        );
      }
      const account = { id: data.user.id, email, salt };
      await saveProfile({
        id: data.user.id,
        email,
        name: values.name,
      });
      account.dataKeyWrapped = keyBundle.dataKeyWrapped;
      account.recoveryKeyWrapped = keyBundle.recoveryKeyWrapped;
      await beginSession(account, keyBundle.dataKey);
      showRecoveryCode(keyBundle.recoveryCode);
    } catch (error) {
      showAuthError(error, "Could not create your account.");
    }
  });
document
  .getElementById("login-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    authMessage();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const email = String(values.email).trim().toLowerCase();
      if (!navigator.onLine) {
        const known = await findLocalAccount(email);
        if (!known)
          throw new Error("First-time login requires an internet connection.");
        const passwordKeys = await deriveKey(
          String(values.password),
          known.salt,
        );
        let key = passwordKeys.key;
        try {
          if (known.data_key_wrapped)
            key = await unwrapDataKey(known.data_key_wrapped, passwordKeys.key);
          else if (known.encrypted_data)
            await decryptPayload(known.encrypted_data, key);
        } catch {
          throw new Error("Wrong password.");
        }
        await beginSession(
          {
            ...known,
            id: known.user_id,
            plan: known.plan || "",
            legacyPasswordKey: known.data_key_wrapped ? null : passwordKeys.key,
          },
          key,
        );
        await openWorkspaceFromLocal();
        return;
      }
      if (!supabaseClient) throw new Error("Supabase is not configured.");
      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email,
        password: String(values.password),
      });
      if (error) throw error;
      if (!data.user) throw new Error("Your account could not be found.");
      // Check access first: it starts the 7-day trial for accounts that have
      // never had one, which the workspace key upgrade below may need.
      let planState = null;
      try {
        planState = await invokeFunction("select-plan", {
          validateCurrent: true,
        });
      } catch (planError) {
        console.warn("Access check deferred; using saved access:", planError);
        const cached = await localWorkspace(data.user.id);
        planState = {
          plan: cached?.plan || "basic",
          trialEndsAt: cached?.trialEndsAt || null,
          planExpiresAt: cached?.planExpiresAt || null,
        };
      }
      const { data: workspace, error: workspaceError } = await supabaseClient
        .from("biztrack_workspaces")
        .select(
          "salt, encrypted_data, updated_at, data_key_wrapped, recovery_key_wrapped",
        )
        .eq("user_id", data.user.id)
        .maybeSingle();
      if (workspaceError) throw workspaceError;
      const salt = workspace?.salt || data.user.user_metadata?.salt;
      if (!salt) throw new Error("Workspace encryption settings are missing.");
      const passwordKeys = await deriveKey(String(values.password), salt);
      let keyBundle;
      if (workspace?.data_key_wrapped) {
        try {
          keyBundle = {
            dataKey: await unwrapDataKey(
              workspace.data_key_wrapped,
              passwordKeys.key,
            ),
            dataKeyWrapped: workspace.data_key_wrapped,
            recoveryKeyWrapped: workspace.recovery_key_wrapped || null,
            recoveryCode: null,
          };
        } catch {
          throw new Error("Wrong password.");
        }
      } else {
        keyBundle = await migrateLegacyWorkspace({
          userId: data.user.id,
          email: data.user.email,
          salt,
          passwordKey: passwordKeys.key,
          initialWorkspace: workspace,
        });
      }
      const account = {
        id: data.user.id,
        email: data.user.email,
        salt,
        plan: planState.plan || "basic",
        trialEndsAt: planState.trialEndsAt,
        planExpiresAt: planState.planExpiresAt,
        trialMode: Boolean(
          planState.trialEndsAt && Date.parse(planState.trialEndsAt) > Date.now(),
        ),
        session: data.session,
        hasWorkspace: Boolean(workspace?.encrypted_data),
        dataKeyWrapped: keyBundle.dataKeyWrapped,
        recoveryKeyWrapped: keyBundle.recoveryKeyWrapped,
        legacyPasswordKey: workspace?.data_key_wrapped
          ? null
          : passwordKeys.key,
      };
      syncNeedsLogin = false;
      await saveProfile({
        id: data.user.id,
        email: data.user.email,
        name: data.user.user_metadata?.name,
      });
      await beginSession(account, keyBundle.dataKey);
      showRecoveryCode(keyBundle.recoveryCode);
    } catch (error) {
      const email = String(values.email || "")
        .trim()
        .toLowerCase();
      const isNetworkFailure =
        error?.name === "AuthRetryableFetchError" ||
        error?.name === "TypeError" ||
        /failed to fetch|network request failed/i.test(error?.message || "");
      if (navigator.onLine && email && isNetworkFailure) {
        try {
          const known = await findLocalAccount(email);
          if (known?.encrypted_data) {
            const passwordKeys = await deriveKey(
              String(values.password),
              known.salt,
            );
            let key = known.data_key_wrapped
              ? await unwrapDataKey(known.data_key_wrapped, passwordKeys.key)
              : passwordKeys.key;
            if (!known.data_key_wrapped) {
              await decryptPayload(known.encrypted_data, key);
              const migrated = await migrateLegacyWorkspace({
                userId: known.user_id,
                email: known.email,
                salt: known.salt,
                passwordKey: passwordKeys.key,
                initialWorkspace: known,
              });
              key = migrated.dataKey;
              known.data_key_wrapped = migrated.dataKeyWrapped;
              known.recovery_key_wrapped = migrated.recoveryKeyWrapped;
            }
            await beginSession(
              {
                ...known,
                id: known.user_id,
                plan: known.plan || "",
                dataKeyWrapped: known.data_key_wrapped || null,
                recoveryKeyWrapped: known.recovery_key_wrapped || null,
                legacyPasswordKey: known.data_key_wrapped
                  ? null
                  : passwordKeys.key,
              },
              key,
            );
            await openWorkspaceFromLocal();
            return;
          }
        } catch {
          // Keep the normal auth error when no local key can unlock the cache.
        }
      }
      showAuthError(
        error,
        "Incorrect email or password, or private data could not be unlocked.",
      );
    }
  });

document
  .getElementById("unlock-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = String(
      new FormData(event.currentTarget).get("password") || "",
    );
    const message = document.getElementById("unlock-message");
    try {
      const account = await findLocalAccount(lockedAccount?.email || "");
      if (!account)
        throw new Error("No offline workspace is saved on this device.");
      const passwordKeys = await deriveKey(password, account.salt);
      const key = account.data_key_wrapped
        ? await unwrapDataKey(account.data_key_wrapped, passwordKeys.key)
        : passwordKeys.key;
      if (account.encrypted_data && !account.data_key_wrapped)
        await decryptPayload(account.encrypted_data, key);
      await beginSession(
        {
          ...account,
          id: account.user_id,
          dataKeyWrapped: account.data_key_wrapped || null,
          recoveryKeyWrapped: account.recovery_key_wrapped || null,
        },
        key,
      );
      await openWorkspaceFromLocal();
      event.currentTarget.reset();
    } catch (error) {
      message.textContent =
        error.message === "No offline workspace is saved on this device."
          ? error.message
          : "Wrong password.";
    }
  });

document.querySelectorAll("[data-recovery-unlock]").forEach((button) => {
  button.addEventListener("click", async () => {
    const email =
      lockedAccount?.email ||
      document
        .querySelector('#login-form input[name="email"]')
        .value.trim()
        .toLowerCase();
    if (!email) {
      authMessage("Enter your account email first.");
      return;
    }
    const code = window.prompt("Enter your saved BizTrack recovery code:");
    if (!code) return;
    try {
      await unlockWithRecoveryCode(email, code);
    } catch {
      const message = document.getElementById("unlock-message");
      if (message)
        message.textContent =
          "Recovery code is invalid or no local workspace is available.";
      else
        authMessage(
          "Recovery code is invalid or no local workspace is available.",
        );
    }
  });
});

let lockedAccount = null;
let inactivityTimer;
const INACTIVITY_LOCK_MS = 30 * 60 * 1000;
// Remembers who was using the app and when, so coming back from the
// background (even if Android closed the app to save memory) reopens the
// workspace without a password. After 30 minutes away, the password is asked
// again, same as the in-app inactivity lock. Logging out always clears it.
const ACTIVE_MARKER_KEY = "biztrack-last-active";
let lastMarkedAt = 0;
const markActive = (force = false) => {
  if (!activeUser) return;
  const now = Date.now();
  if (!force && now - lastMarkedAt < 15000) return;
  lastMarkedAt = now;
  try {
    localStorage.setItem(
      ACTIVE_MARKER_KEY,
      JSON.stringify({ userId: activeUser.id, at: now }),
    );
  } catch {
    // Without storage the user simply logs in again next time.
  }
};
const clearActiveMarker = () => {
  lastMarkedAt = 0;
  try {
    localStorage.removeItem(ACTIVE_MARKER_KEY);
  } catch {
    // Nothing to clear.
  }
};
const resetInactivityTimer = () => {
  markActive();
  clearTimeout(inactivityTimer);
  if (
    !activeUser ||
    document.querySelector(".app")?.classList.contains("hidden")
  )
    return;
  inactivityTimer = setTimeout(async () => {
    if (!activeUser) return;
    clearActiveMarker();
    lockedAccount = {
      id: activeUser.id,
      email: activeUser.email,
      salt: activeUser.salt,
    };
    activeUser = null;
    document.querySelector(".app").classList.add("hidden");
    document.getElementById("lock-account-email").textContent =
      lockedAccount.email || "Enter your password to unlock this device.";
    document.getElementById("unlock-message").textContent = "";
    document.getElementById("lock-screen").classList.remove("hidden");
    document.getElementById("unlock-password").focus();
  }, INACTIVITY_LOCK_MS);
};
["pointerdown", "keydown", "touchstart", "click"].forEach((eventName) =>
  document.addEventListener(eventName, resetInactivityTimer, { passive: true }),
);

document.querySelectorAll(".plan-choice").forEach((button) => {
  button.addEventListener("click", async () => {
    const plan = button.dataset.plan;
    const message = document.getElementById("plan-message");
    message.textContent = "";
    try {
      if (!activeUser) throw new Error("Unlock your workspace first.");
      const state = accessState();
      const trialUsed = Boolean(activeUser.trialEndsAt);
      // Pro and Premium are always paid. Basic is free only for the first 7 days.
      if (plan !== "basic" || (trialUsed && state.access === "read_only")) {
        openPaymentDialog(plan);
        return;
      }
      if (!trialUsed) {
        if (!navigator.onLine)
          throw new Error("Connect to the internet to start your free trial.");
        await applyAccess(await invokeFunction("select-plan", { plan: "basic" }));
      }
      await enterWorkspace();
      loadPaymentStatuses();
    } catch (error) {
      message.textContent = error.message;
    }
  });
});
document
  .getElementById("change-plan-link")
  ?.addEventListener("click", (event) => {
    event.preventDefault();
    if (activeUser) {
      document.querySelector(".app").classList.add("hidden");
      document.getElementById("plan-screen").classList.remove("hidden");
      showPlanSelection();
    }
  });
document.getElementById("logout-button").addEventListener("click", async () => {
  const current = activeUser ? await localWorkspace(activeUser.id) : null;
  if (current?.unsynced || current?.planUnsynced) {
    const shouldSync = window.confirm(
      "There are unsynced changes. Sync before logging out? Cancel to stay signed in.",
    );
    if (!shouldSync) return;
    await syncWorkspace();
    const afterSync = await localWorkspace(activeUser.id);
    if (afterSync?.unsynced || afterSync?.planUnsynced) {
      const logOutWithLocalCopy = window.confirm(
        "Sync is unavailable. Log out and keep the unsynced encrypted data on this device?",
      );
      if (!logOutWithLocalCopy) return;
    }
  }
  const latest = activeUser ? await localWorkspace(activeUser.id) : null;
  const removeDeviceData =
    latest?.unsynced || latest?.planUnsynced
      ? false
      : window.confirm(
          "Remove this device's offline data? Choose Cancel to keep offline access.",
        );
  clearActiveMarker();
  try {
    if (navigator.onLine && supabaseClient) await supabaseClient.auth.signOut();
  } finally {
    if (removeDeviceData && activeUser)
      await removeLocalWorkspace(activeUser.id);
    activeUser = null;
    activePlan = "";
    currentBusinessId = "";
    currentProfile = null;
    renderProfileChip();
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
  const cacheKey = "biztrack-news-cache-v1";
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(cacheKey) || "null");
    } catch {
      return null;
    }
  })();
  let response = null;
  let offlineNotice = !navigator.onLine;
  if (navigator.onLine && supabaseClient) {
    try {
      const { data } = await supabaseClient.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Login is required to refresh news.");
      const result = await fetch(`${supabaseConfig.url}/functions/v1/news`, {
        headers: {
          apikey: supabaseConfig.anonKey,
          Authorization: `Bearer ${token}`,
        },
      });
      if (!result.ok) throw new Error("News could not be refreshed.");
      response = await result.json();
      if (!Array.isArray(response.items))
        throw new Error("News response was invalid.");
      response.savedAt = new Date().toISOString();
      localStorage.setItem(cacheKey, JSON.stringify(response));
    } catch (error) {
      console.warn("News refresh failed:", error);
      offlineNotice = false;
    }
  }
  const displayed = response || saved;
  const savedLabel = displayed?.savedAt
    ? formatLocalDate(displayed.savedAt) +
      " " +
      new Date(displayed.savedAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  const notice = response
    ? ""
    : displayed
    ? `<p class="news-cache-note">Showing saved news from ${escapeHtml(
        savedLabel,
      )}${offlineNotice ? " — you're offline" : " — refresh failed"}</p>`
    : `<div class="empty">${
        offlineNotice
          ? "News needs an internet connection. No saved headlines are available yet."
          : "News could not be loaded. Try again when connected."
      }</div>`;
  const items = displayed?.items || [];
  container.innerHTML = `
    <div class="card">
      <div class="section-title">Latest business news</div>
      ${notice}
      ${
        items.length
          ? `<div class="news-items">${items
              .map(
                (item) =>
                  `<article class="news-item"><a href="${escapeHtml(
                    item.link,
                  )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
                    item.title,
                  )}</a><div class="news-meta">${escapeHtml(
                    item.source || "News",
                  )} · ${formatLocalDate(item.published)}</div><p>${escapeHtml(
                    item.summary || "",
                  )}</p></article>`,
              )
              .join("")}</div>`
          : ""
      }
    </div>
  `;
}
document.getElementById("news-refresh")?.addEventListener("click", loadNews);

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
              `<tr><td data-label="Business">${escapeHtml(
                business.name,
              )}</td><td data-label="Income" style="text-align:right">${fmt(
                business.income,
              )}</td><td data-label="Expenses" style="text-align:right">${fmt(
                business.expenses,
              )}</td><td data-label="Net profit / loss" style="text-align:right" class="${
                business.net_profit >= 0 ? "good" : "bad"
              }">${fmt(business.net_profit)}</td></tr>`,
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
  document.getElementById("d-sales-label").textContent = `${period} ${uiText(
    "Sales",
  )}`;
  document.getElementById("d-income-label").textContent = `${period} ${uiText(
    "Income",
  )}`;
  document.getElementById("d-expenses-label").textContent = `${period} ${uiText(
    "Expenses",
  )}`;
  document.getElementById("d-profit-label").textContent = `${period} ${uiText(
    "Net Profit",
  )}`;
  document.getElementById("d-sales").textContent = fmt(d.sales_total);
  document.getElementById("d-sales-units").textContent = `${
    d.sales_units
  } ${uiText("items invoiced")}`;
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
  document.getElementById("inventory-title").textContent = `${uiText(
    "Inventory",
  )} — ${period}`;
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
      <span>${escapeHtml(p.name)}</span><span class="pill low">${
              p.stock_qty
            } ${escapeHtml(p.unit || "unit")} ${uiText("left")}</span>
    </div>`,
        )
        .join("")
    : `<div class="empty">${uiText("All stock levels healthy.")}</div>`;

  const topEl = document.getElementById("d-top-products");
  topEl.innerHTML =
    d.top_products
      .map(
        (p) =>
          `<tr><td data-label="Product">${escapeHtml(
            p.name,
          )}</td><td data-label="Qty Sold">${
            p.qty_sold
          }</td><td data-label="Revenue">${fmt(p.revenue)}</td></tr>`,
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
  document.getElementById("pl-title").textContent = `${uiText(
    "Profit & Loss",
  )} — ${uiText(pl.period_label)}`;
  document.getElementById("pl-income").innerHTML =
    pl.income_by_category
      .map(
        (r) =>
          `<tr><td>${escapeHtml(
            r.category,
          )}</td><td style="text-align:right">${fmt(r.total)}</td></tr>`,
      )
      .join("") ||
    `<tr><td class="empty">${uiText("No income recorded.")}</td></tr>`;
  document.getElementById("pl-expense").innerHTML =
    pl.expense_by_category
      .map(
        (r) =>
          `<tr><td>${escapeHtml(
            r.category,
          )}</td><td style="text-align:right">${fmt(r.total)}</td></tr>`,
      )
      .join("") ||
    `<tr><td class="empty">${uiText("No expenses recorded.")}</td></tr>`;
  const netEl = document.getElementById("pl-net");
  netEl.textContent = fmt(pl.net_profit);
  netEl.style.color = pl.net_profit >= 0 ? "var(--good)" : "var(--bad)";

  document.getElementById("txn-list").innerHTML = txns
    .map(
      (t) => `<tr>
    <td data-label="Date">${formatLocalDate(t.occurred_at)}</td>
    <td data-label="Type"><span class="pill ${
      t.type === "income" ? "ok" : "low"
    }">${escapeHtml(t.type)}</span></td>
    <td data-label="Category">${escapeHtml(
      t.category,
    )}</td><td data-label="Description">${escapeHtml(t.description || "")}</td>
    <td data-label="Amount" style="text-align:right">${fmt(
      t.amount,
    )}</td></tr>`,
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
    e.target.elements.occurred_at.value = `${today.getFullYear()}-${String(
      today.getMonth() + 1,
    ).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
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
    <td data-label="Product">${escapeHtml(
      p.name,
    )}</td><td data-label="Category">${escapeHtml(p.category || "")}</td>
    <td data-label="Stock"><span class="pill ${statusClass}">${
        p.stock_qty
      } ${escapeHtml(
        p.unit || "unit",
      )}</span><div class="sub">${status}</div></td>
    <td data-label="Reorder Level">${
      p.stock_qty <= LOW_STOCK_THRESHOLD ? LOW_STOCK_THRESHOLD : "—"
    }</td><td data-label="Cost Price">${fmt(
        p.cost_price,
      )}</td><td data-label="Sell Price">${fmt(p.sell_price)}</td>
    <td data-label="Adjust" class="row-actions">
      <button class="btn small secondary" onclick="adjustStock('${escapeHtml(
        p.id,
      )}', 10)">+10</button>
      <button class="btn small secondary" onclick="adjustStock('${escapeHtml(
        p.id,
      )}', -10)">-10</button>
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
        <span class="badge-trend ${trendUp ? "up" : "down"}">${
      trendUp ? "▲" : "▼"
    } 14-day trend</span>
      </div>
      <div class="flex" style="font-size:13px;color:var(--muted);margin-top:6px;">
        <span>Your price: <strong style="color:var(--ink)">${fmt(
          item.your_sell_price,
        )}</strong></span>
        <span>Market price: <strong style="color:var(--ink)">${fmt(
          item.latest_market_price,
        )}</strong></span>
        <span>Supplier (${
          item.latest_supplier_name
        }): <strong style="color:var(--ink)">${fmt(
      item.latest_supplier_price,
    )}</strong></span>
        <span>Suggested price: <strong style="color:var(--amber)">${fmt(
          item.suggested_sell_price,
        )}</strong></span>
      </div>
      <div class="price-gauge">
        <div class="bar" style="left:${pct(item.your_cost_price)}%;width:${
      pct(item.your_sell_price) - pct(item.your_cost_price)
    }%;"></div>
        <div class="marker" style="left:${pct(
          item.latest_market_price,
        )}%;"><div class="tag">Market</div></div>
        <div class="marker" style="left:${pct(
          item.your_sell_price,
        )}%;border-color:var(--amber);background:var(--amber);"><div class="tag" style="color:var(--amber)">You</div></div>
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
  document.getElementById("customer-names").innerHTML = customersCache
    .map((c) => `<option value="${c.id}">${c.name}</option>`)
    .join("");
  document.getElementById("inventory-product-names").innerHTML = productsCache
    .map((product) => `<option value="${escapeHtml(product.name)}"></option>`)
    .join("");

  const invoices = await api("/invoices");
  document.getElementById("invoice-list").innerHTML = invoices
    .map(
      (i) => `<tr>
    <td data-label="Date">${formatLocalDate(
      i.created_at,
    )}</td><td data-label="Customer">${escapeHtml(
        i.customer_name,
      )}</td><td data-label="Product">${escapeHtml(i.product_name)}</td>
    <td data-label="Qty">${i.qty}</td><td data-label="Price">${fmt(
        i.unit_price,
      )}</td><td data-label="Total">${fmt(i.total)}</td>
    <td data-label="Status"><span class="pill ${i.status}">${escapeHtml(
        i.status,
      )}</span></td>
    <td data-label="Actions" class="row-actions">${
      i.status === "unpaid"
        ? `<button class="btn small secondary" onclick="markPaid('${escapeHtml(
            i.id,
          )}')">Mark Paid</button>`
        : ""
    }</td>
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

if (isNativeApp) {
  const plugins = capacitor?.Plugins || {};
  plugins.Network?.addListener?.("networkStatusChange", (status) => {
    if (status.connected) syncAfterResume();
  });
  plugins.App?.addListener?.("resume", syncAfterResume);
  plugins.App?.addListener?.("backButton", () => {
    if (sidebar?.classList.contains("open")) {
      closeMobileMenu();
    } else if (!renameDialog.classList.contains("hidden")) {
      closeRenameDialog();
    } else if (!contextMenu.classList.contains("hidden")) {
      hideBusinessMenu();
    } else if (currentTab !== "businesses" && tabHistory.length) {
      activateTab(tabHistory.at(-1), true);
    } else {
      plugins.App?.exitApp?.();
    }
  });
  plugins.StatusBar?.setBackgroundColor?.({ color: "#0b4f4a" });
  plugins.StatusBar?.setOverlaysWebView?.({ overlay: false });
}

// The app starts at Businesses. Select a business, then choose a feature manually.
if ("serviceWorker" in navigator && !isNativeApp) {
  let reloadAfterUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadAfterUpdate) window.location.reload();
  });
  const showWaitingUpdate = (registration) => {
    if (!registration.waiting || !navigator.serviceWorker.controller) return;
    clearTimeout(showToast.timer);
    const toast = document.getElementById("toast");
    toast.replaceChildren(document.createTextNode("New version available — "));
    const reloadButton = document.createElement("button");
    reloadButton.type = "button";
    reloadButton.className = "btn small update-reload";
    reloadButton.textContent = "Reload";
    reloadButton.addEventListener("click", () => {
      reloadAfterUpdate = true;
      registration.waiting?.postMessage({ type: "SKIP_WAITING" });
    });
    toast.append(reloadButton);
    toast.className = "toast show update-toast";
  };
  navigator.serviceWorker
    .register("./sw.js", { scope: "./", updateViaCache: "none" })
    .then((registration) => {
      showWaitingUpdate(registration);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed") showWaitingUpdate(registration);
        });
      });
    })
    .catch((error) =>
      console.warn("Service worker registration failed:", error),
    );
}

// Reopen the workspace if this device was in use within the last 30 minutes.
const resumeRecentSession = async () => {
  if (openedFromResetLink) return false;
  let marker = null;
  try {
    marker = JSON.parse(localStorage.getItem(ACTIVE_MARKER_KEY) || "null");
  } catch {
    marker = null;
  }
  if (!marker?.userId) return false;
  if (!(Date.now() - marker.at < INACTIVITY_LOCK_MS)) {
    clearActiveMarker();
    return false;
  }
  const local = await localWorkspace(marker.userId);
  const key = local?.cachedKey;
  if (!key || typeof key !== "object") return false;
  if (local.encrypted_data) {
    try {
      await decryptPayload(local.encrypted_data, key);
    } catch {
      clearActiveMarker();
      return false;
    }
  }
  let session = null;
  if (supabaseClient) {
    try {
      session = (await supabaseClient.auth.getSession()).data.session;
    } catch {
      session = null;
    }
  }
  if (session && session.user?.id !== marker.userId) return false;
  await beginSession(
    {
      ...local,
      id: local.user_id,
      plan: local.plan || "",
      session,
      legacyPasswordKey: local.data_key_wrapped
        ? null
        : local.legacyPasswordKey || null,
      dataKeyWrapped: local.data_key_wrapped || null,
      recoveryKeyWrapped: local.recovery_key_wrapped || null,
    },
    key,
  );
  if (navigator.onLine) refreshAccessFromServer();
  return true;
};
document.documentElement.classList.add("resuming");
resumeRecentSession()
  .catch((error) => console.warn("Could not reopen the last session:", error))
  .finally(() => document.documentElement.classList.remove("resuming"));
