// CONFIG
const BACKEND_URL = "https://sistema-estoque-max.vercel.app"; // URL padrão de produção

document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const viewLogin = document.getElementById('view-login');
  const viewMain = document.getElementById('view-main');
  const inputEmail = document.getElementById('login-email');
  const inputPass = document.getElementById('login-pass');
  const loginError = document.getElementById('login-error');
  const btnLogin = document.getElementById('btn-login');
  
  const tabScan = document.getElementById('tab-scan');
  const tabConfig = document.getElementById('tab-config');
  const tabBtns = document.querySelectorAll('.tab-btn');
  
  const currentDomain = document.getElementById('current-domain');
  const currentStatus = document.getElementById('current-status');
  const domainIndicator = document.getElementById('domain-indicator');
  const btnScan = document.getElementById('btn-scan');
  const scanTip = document.getElementById('scan-tip');
  const userEmailSpan = document.getElementById('user-email');
  const btnLogout = document.getElementById('btn-logout');
  
  const configCurrentDomain = document.getElementById('config-current-domain');
  const btnToggleAuth = document.getElementById('btn-toggle-auth');
  const authorizedList = document.getElementById('authorized-list');

  let activeTab = null;
  let activeDomain = "";

  // Check login state
  const state = await chrome.storage.local.get(['token', 'email', 'authorizedDomains']);
  const authorizedDomains = state.authorizedDomains || [];
  
  if (state.token) {
    showMainView(state.email);
  } else {
    showLoginView();
  }

  // Get Active Tab Info
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs && tabs[0]) {
    activeTab = tabs[0];
    if (activeTab.url && activeTab.url.startsWith('http')) {
      const urlObj = new URL(activeTab.url);
      activeDomain = urlObj.hostname;
    }
  }

  updateDomainDisplay();
  renderAuthorizedSites();

  // Tab switching
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const tabId = btn.getAttribute('data-tab');
      if (tabId === 'tab-scan') {
        tabScan.classList.remove('hidden');
        tabConfig.classList.add('hidden');
      } else {
        tabScan.classList.add('hidden');
        tabConfig.classList.remove('hidden');
      }
    });
  });

  // Action: LOGIN
  btnLogin.addEventListener('click', async () => {
    const email = inputEmail.value.trim();
    const password = inputPass.value.trim();
    if (!email || !password) {
      showError("Preencha todos os campos.");
      return;
    }

    btnLogin.disabled = true;
    btnLogin.textContent = "Conectando...";
    loginError.textContent = "";

    try {
      // Rota dedicada da extensão: devolve o JWT no CORPO da resposta (a
      // extensão não tem cookie jar de navegador) — /api/auth/login normal
      // só grava um cookie httpOnly, que a extensão nunca conseguiria ler.
      const res = await fetch(`${BACKEND_URL}/api/auth/extension-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao conectar.");
      if (!data.token) throw new Error("Servidor não retornou token de acesso.");

      await chrome.storage.local.set({ token: data.token, email: email });
      showMainView(email);
    } catch (err) {
      showError(err.message);
      btnLogin.disabled = false;
      btnLogin.textContent = "Entrar";
    }
  });

  // Action: LOGOUT
  btnLogout.addEventListener('click', async () => {
    await chrome.storage.local.remove(['token', 'email']);
    showLoginView();
  });

  // Action: TOGGLE AUTHORIZATION
  btnToggleAuth.addEventListener('click', async () => {
    if (!activeDomain) return;
    
    let list = [...authorizedDomains];
    const index = list.indexOf(activeDomain);
    
    if (index === -1) {
      list.push(activeDomain);
    } else {
      list.splice(index, 1);
    }
    
    await chrome.storage.local.set({ authorizedDomains: list });
    location.reload(); // Refresh popup state
  });

  // Action: SCAN PAGE
  btnScan.addEventListener('click', () => {
    if (!activeTab || !activeDomain) return;
    
    btnScan.disabled = true;
    btnScan.textContent = "Escaneando...";
    
    chrome.runtime.sendMessage({
      action: "start_scan",
      tabId: activeTab.id,
      domain: activeDomain
    }, (response) => {
      if (response && response.error) {
        alert("Erro no scan: " + response.error);
        btnScan.disabled = false;
        btnScan.innerHTML = `
          <svg class="icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2A10 10 0 1 0 22 12A10 10 0 0 0 12 2M12 20A8 8 0 1 1 20 12A8 8 0 0 1 12 20M11 7H13V13H11M11 15H13V17H11Z"/></svg>
          Scan Supplier Catalog
        `;
      } else {
        // Background will open review page, close popup
        window.close();
      }
    });
  });

  // Helper: VIEW MANAGEMENT
  function showLoginView() {
    viewLogin.classList.remove('hidden');
    viewMain.classList.add('hidden');
  }

  function showMainView(email) {
    viewLogin.classList.add('hidden');
    viewMain.classList.remove('hidden');
    userEmailSpan.textContent = email;
  }

  function showError(msg) {
    loginError.textContent = msg;
  }

  // Helper: DOMAIN HANDLING
  function updateDomainDisplay() {
    if (!activeDomain) {
      currentDomain.textContent = "Nenhuma página web ativa";
      configCurrentDomain.textContent = "Nenhuma página web ativa";
      currentStatus.textContent = "Inativo";
      domainIndicator.className = "status-indicator";
      btnScan.disabled = true;
      btnToggleAuth.disabled = true;
      scanTip.textContent = "Abra o catálogo do fornecedor para começar.";
      return;
    }

    currentDomain.textContent = activeDomain;
    configCurrentDomain.textContent = activeDomain;

    const isAuth = authorizedDomains.includes(activeDomain);
    
    if (isAuth) {
      currentStatus.textContent = "Site Autorizado";
      domainIndicator.className = "status-indicator authorized";
      btnScan.disabled = false;
      btnToggleAuth.textContent = "Desautorizar Site";
      btnToggleAuth.className = "btn btn-secondary btn-danger-hover"; // customize or reuse
      scanTip.textContent = "O site está autorizado. Pronto para escanear catalogos.";
      scanTip.style.color = "var(--success)";
    } else {
      currentStatus.textContent = "Não Autorizado";
      domainIndicator.className = "status-indicator blocked";
      btnScan.disabled = true;
      btnToggleAuth.textContent = "Autorizar Site";
      btnToggleAuth.className = "btn btn-primary";
      scanTip.textContent = "O site atual não está autorizado. Ative-o nas configurações.";
      scanTip.style.color = "var(--tx-muted)";
    }
  }

  function renderAuthorizedSites() {
    authorizedList.innerHTML = "";
    if (authorizedDomains.length === 0) {
      authorizedList.innerHTML = '<li class="empty-list">Nenhum site autorizado ainda.</li>';
      return;
    }

    authorizedDomains.forEach(domain => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span>${domain}</span>
        <button class="btn-remove-site" data-domain="${domain}">
          <svg style="width:14px;height:14px;" viewBox="0 0 24 24"><path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>
        </button>
      `;
      authorizedList.appendChild(li);
    });

    // Add remove listeners
    document.querySelectorAll('.btn-remove-site').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const dom = btn.getAttribute('data-domain');
        let list = authorizedDomains.filter(d => d !== dom);
        await chrome.storage.local.set({ authorizedDomains: list });
        location.reload();
      });
    });
  }

  // Listen for scan progress from content.js
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "scan_progress") {
      const scanTip = document.getElementById('scan-tip');
      const btnScan = document.getElementById('btn-scan');
      if (scanTip) {
        scanTip.textContent = `[${message.status.strategy}] ${message.status.message}`;
        scanTip.style.color = "var(--primary)";
      }
      if (btnScan) {
        btnScan.textContent = "Escaneando...";
        btnScan.disabled = true;
      }
    }
  });
});
