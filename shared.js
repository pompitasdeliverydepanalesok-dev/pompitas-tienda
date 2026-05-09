/* ============================================================
   POMPITAS · shared.js · V2
   ============================================================
   Código común a tienda (index.html) y admin (admin.html).
   Expone módulos vía `window.Pompitas`:
     - Pompitas.config       → claves de almacenamiento, constantes
     - Pompitas.parser       → pdf.js parsing + clasificación + desglose talles
     - Pompitas.api          → cliente del backend Apps Script
     - Pompitas.format       → formateo de moneda, fecha, etc.
     - Pompitas.cart         → carrito persistente (solo se usa en tienda)
     - Pompitas.utils        → util varios
   ============================================================ */
(function (global) {
  'use strict';

  /* ============================================================
     1. CONFIG GLOBAL
     ============================================================ */
  const VERSION = '2.0.0';

  const STORAGE_KEYS = {
    SHEETS_URL: 'pompitas_sheets_url',
    SHEETS_TOKEN: 'pompitas_sheets_token',
    THEME: 'pompitas_theme',
    CART: 'pompitas_cart_v2',
    LAST_PRODUCTS: 'pompitas_last_products_v2',
    LAST_CONFIG: 'pompitas_last_config_v2',
    MARKUPS: 'pompitas_markups',
    LAST_SYNC: 'pompitas_last_sync'
  };

  const DEFAULT_MARKUPS = {
    markupPanales: 25,
    markupHigiene: 45
  };

  /* ============================================================
     2. CLASIFICADOR — keywords y marcas
     ============================================================ */
  const KEYWORDS_PANALES = [
    'pañal','panal','pants','babydry','baby dry','premium care','premiun care',
    'ultrasoft','ultra soft','superpack','hiperpack','mes de consumo',
    'elastizado','recto','adulto','incontinencia','ropa interior descartable',
    'classic','protect','flexi','natural care','dermacare','soft comfort',
    'goodnight','splashers','little swimmers','aposito','apósito',
    'refuerza','refuerzo','zalea','bombachas plasticas','cubre colchon'
  ];

  const KEYWORDS_HIGIENE = [
    'toallitas','toallita','t.humedas','t. humedas','humedas','húmedas',
    'óleo','oleo','shampoo','shampo','jabon','jabón','colonia',
    'algodón','algodon','hisopo','crema','alcohol','talco','gasa',
    'paño','pano','protectores mamarios','acondicionador','baño liquido',
    'aceite','guantes latex','cotonete','cotonetes','paño jabonoso'
  ];

  // Marcas ordenadas por especificidad (más largas primero para evitar matches parciales)
  const BRANDS = [
    "Johnson's Baby","Dove Baby","Baby Basic","Babydry","Babysan",
    "Pampers","Huggies","Babysec","Estrella","Plenitud","Tena","Nonino",
    "Nonisec","Comodín","Comodin","Q-Soft","Qsoft","Ideal","Duffy",
    "Toddler","Doncella","Indasec","Indas","EWE","Hennia","Ambos",
    "Baño Facil","Baño Fácil","Igaltex"
  ];

  const BRAND_NORMALIZE = {
    "Babydry": "Pampers","Babysan": "Pampers",
    "Baño Fácil": "Baño Facil",
    "Comodin": "Comodín",
    "Qsoft": "Q-Soft",
    "Indasec": "Indas"
  };

  const IGNORE_PATTERNS = [
    /^tipo de producto/i, /^precio$/i,
    /^pañales y articulos/i, /^panales y articulos/i,
    /^perfumeria/i, /^varios$/i,
    /^hac[eé] tu pedido/i, /whatsapp/i,
    /^esta lista puede sufrir/i, /^lista correspondiente/i,
    /^distribuimos las marcas/i, /^el mejor precio/i, /^¡el mejor/i,
    /^av\.\s/i, /^pje\.\s/i,
    /^gracias por confiar/i, /^¡gracias/i,
    /^modif\./i, /^\s*$/, /^\d+$/
  ];

  // Talles canónicos en orden de especificidad (más largos primero)
  const SIZE_TOKENS = [
    'XXXG','XXXL','XXG','XXL','XG','XL','XP','XS','RN',
    'SG','MG','PP','GG',
    'P','M','G','L','S'
  ];

  /* ============================================================
     3. PARSER — utilidades de bajo nivel
     ============================================================ */

  function isBrandHeader(line) {
    const trimmed = line.trim();
    if (trimmed.length < 3 || trimmed.length > 30) return false;
    if (/\d/.test(trimmed)) return false;
    const letters = trimmed.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '');
    if (letters.length < 3) return false;
    const upperRatio = letters.replace(/[^A-ZÁÉÍÓÚÑ]/g, '').length / letters.length;
    if (upperRatio < 0.7) return false;
    const norm = trimmed.toUpperCase();
    return BRANDS.some(b => b.toUpperCase() === norm);
  }

  /**
   * Normaliza un precio en formato AR o US a número entero.
   *  "12,850.00"     -> 12850
   *  "OF. 35.590,00" -> 35590
   *  "$12.500"       -> 12500
   */
  function parsePrice(raw) {
    if (raw === null || raw === undefined) return null;
    const str = String(raw).trim();
    if (/sin\s*stock/i.test(str)) return { value: null, noStock: true };

    let cleaned = str.replace(/of\.?\s*/i, '').replace(/\$/g, '').replace(/\s/g, '').trim();
    if (!cleaned) return null;

    const m = cleaned.match(/[\d.,]+/);
    if (!m) return null;
    cleaned = m[0];

    const lastDot = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');

    let value;
    if (lastDot === -1 && lastComma === -1) {
      value = parseInt(cleaned, 10);
    } else if (lastDot > lastComma) {
      value = parseFloat(cleaned.replace(/,/g, ''));
    } else if (lastComma > lastDot) {
      value = parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
    } else {
      if (cleaned.includes(',')) {
        const parts = cleaned.split(',');
        if (parts[parts.length - 1].length === 3) value = parseFloat(cleaned.replace(/,/g, ''));
        else value = parseFloat(cleaned.replace(',', '.'));
      } else {
        const parts = cleaned.split('.');
        if (parts[parts.length - 1].length === 3) value = parseFloat(cleaned.replace(/\./g, ''));
        else value = parseFloat(cleaned);
      }
    }

    if (isNaN(value) || value <= 0) return null;
    return { value: Math.round(value), noStock: false };
  }

  function extractProductFromLine(line) {
    const text = line.trim();
    if (!text || text.length < 6) return null;

    const noStockMatch = text.match(/^(.+?)\s+sin\s*stock\s*$/i);
    if (noStockMatch) {
      const name = noStockMatch[1].trim();
      if (name.length >= 6) return { name, price: null, noStock: true };
    }

    const priceRegex = /(?:of\.?\s*)?\$?\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+)\s*$/i;
    const match = text.match(priceRegex);
    if (!match) return null;

    const priceStr = match[0];
    const parsed = parsePrice(priceStr);
    if (!parsed || parsed.value === null) return null;
    if (parsed.value < 100 || parsed.value > 10000000) return null;

    const name = text.slice(0, text.length - priceStr.length).trim();
    if (name.length < 6) return null;

    return { name, price: parsed.value, noStock: false };
  }

  function cleanProductName(name) {
    return String(name)
      .replace(/\s+/g, ' ')
      .replace(/[\u0000-\u001F]/g, '')
      .replace(/^[-•·.]+/, '')
      .replace(/\s*\.\s*$/, '')
      .trim();
  }

  function detectCategory(name) {
    const lower = String(name).toLowerCase();
    for (const kw of KEYWORDS_HIGIENE) {
      if (lower.includes(kw)) return 'HIGIENE';
    }
    for (const kw of KEYWORDS_PANALES) {
      if (lower.includes(kw)) return 'PAÑALES';
    }
    return 'OTROS';
  }

  function detectBrandFromName(name) {
    const upper = String(name).toUpperCase();
    for (const brand of BRANDS) {
      const re = new RegExp('\\b' + brand.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      if (re.test(upper)) {
        return BRAND_NORMALIZE[brand] || brand;
      }
    }
    return null;
  }

  function roundUpTo10(n) {
    return Math.ceil(n / 10) * 10;
  }

  /* ============================================================
     3.b PARSER — desglose y extracción de talles
     ============================================================ */

  /**
   * Detecta si el nombre contiene un grupo de talles.
   *
   * Soporta dos patrones reales:
   *   A) "TALLE/TALLE/TALLE" simple. Ej: "XG/XXG", "M/G/XG"
   *   B) "TALLExCANT/TALLExCANT/..." (formato Hiper del Pañal).
   *      Ej: "Mx72/Gx72/XGx58/XXGx54"
   *      → desglosa en M, G, XG, XXG (las cantidades quedan implícitas en el nombre)
   *
   * Devuelve { sizes, groupString, units? } o null si no es un grupo.
   * - sizes: array de talles (XG, XXG, etc.)
   * - groupString: substring exacto a reemplazar al desglosar
   * - units: array paralelo a sizes con las cantidades por talle (solo en patrón B)
   */
  function detectSizeGroup(name) {
    const text = String(name);

    // ---- PATRÓN B: TALLExN/TALLExN/... (el más común en este PDF) ----
    // Ordenamos talles más largos primero para evitar que "G" matchee antes que "XG"
    const tokenAlt = SIZE_TOKENS.slice().sort((a, b) => b.length - a.length).join('|');
    // Cada item: TALLE seguido de "x" minúscula o mayúscula, seguido de número.
    // Grupo completo: 2+ items separados por "/"
    const itemPattern = '(?:' + tokenAlt + ')[xX]\\d+';
    const groupBRe = new RegExp('\\b((?:' + itemPattern + ')(?:/(?:' + itemPattern + ')){1,5})\\b');
    const mB = text.match(groupBRe);
    if (mB) {
      const groupStr = mB[1];
      const items = groupStr.split('/');
      const sizes = [];
      const units = [];
      const pairRe = new RegExp('^(' + tokenAlt + ')[xX](\\d+)$', 'i');
      for (const item of items) {
        const pm = item.match(pairRe);
        if (!pm) return null; // si algún item no matchea, descartamos el grupo entero
        sizes.push(pm[1].toUpperCase());
        units.push(parseInt(pm[2], 10));
      }
      // Mínimo 2 talles distintos para considerar desglose útil
      const uniqueSizes = Array.from(new Set(sizes));
      if (uniqueSizes.length < 2) return null;
      return { sizes, units, groupString: groupStr, pattern: 'B' };
    }

    // ---- PATRÓN A: TALLE/TALLE/TALLE simple (sin cantidades) ----
    // Importante: solo aplica si los items NO tienen "x<número>" pegado.
    // Cada item es solo un talle y no debe ser parte de un patrón B.
    const groupARe = new RegExp(
      '(^|\\s)((?:' + tokenAlt + ')(?:/(?:' + tokenAlt + ')){1,4})(?=\\s|$)',
      ''
    );
    const mA = text.toUpperCase().match(groupARe);
    if (!mA) return null;

    const groupStr = mA[2];
    // Buscar la posición real (case-insensitive) en el texto original
    const idx = text.toUpperCase().indexOf(groupStr);
    if (idx === -1) return null;
    const realGroupStr = text.substring(idx, idx + groupStr.length);

    const sizes = groupStr.split('/').map(s => s.trim()).filter(Boolean);
    if (sizes.length < 2) return null;

    const allValid = sizes.every(s => SIZE_TOKENS.indexOf(s.toUpperCase()) !== -1);
    if (!allValid) return null;

    return {
      sizes: sizes.map(s => s.toUpperCase()),
      groupString: realGroupStr,
      pattern: 'A'
    };
  }

  /**
   * Extrae UN talle del nombre (no grupo). Para casos donde ya no hay agrupación.
   * Devuelve string con el talle o '' si no encuentra.
   */
  function extractSingleSize(name) {
    if (!name) return '';
    const upper = String(name).toUpperCase();
    for (const s of SIZE_TOKENS) {
      // Talle como palabra suelta (rodeada de espacios/bordes/signos)
      const re = new RegExp('(^|\\s|/)' + s + '($|\\s|/)');
      if (re.test(upper)) return s;
    }
    return '';
  }

  /**
   * Aplica reglas de override de categoría (zalea, apósito, refuerza, incontinencia).
   * Devuelve la categoría final después de aplicar reglas.
   */
  function applyCategoryOverrides(name, brand, category) {
    const lowerName = String(name).toLowerCase();
    const brandLower = String(brand || '').toLowerCase();

    const isHygieneByKeyword =
      /\bzale[ai]\b/.test(lowerName) ||
      /\bap[oó]sito?s?\b/.test(lowerName) ||
      /\bapos\b/.test(lowerName) ||
      /\brefuerz[ao]\s*pa[nñ]al\b/.test(lowerName) ||
      /\brefuerz[ao]s?\b/.test(lowerName);

    const hasIncontinencia = /\bincontinencia\b/.test(lowerName);
    const isExcludedBrand = brandLower === 'plenitud' || brandLower === 'indasec' || brandLower === 'indas';
    const isHygieneByIncontinencia = hasIncontinencia && !isExcludedBrand;

    if (isHygieneByKeyword || isHygieneByIncontinencia) return 'HIGIENE';
    return category;
  }

  /* ============================================================
     3.c PARSER — pipeline completo
     ============================================================ */

  /**
   * Pipeline V2: líneas crudas → productos enriquecidos con desglose de talles.
   *
   * Por cada línea:
   *   1. Extrae nombre + precio
   *   2. Clasifica categoría + marca + override
   *   3. Si detecta talles agrupados (XG/XXG), genera N productos:
   *        nombre canónico (sin grupo), talle individual, mismo precio.
   *   4. Si no hay grupo, extrae talle único.
   */
  function parseProductsFromLines(lines, markups) {
    const products = [];
    let currentBrand = null;
    let currentSection = null;

    const seen = new Set();

    for (const rawLine of lines) {
      const line = String(rawLine).replace(/\s+/g, ' ').trim();
      if (!line) continue;

      if (IGNORE_PATTERNS.some(p => p.test(line))) continue;

      // Cambio de sección
      if (/pañales y articulos bebes/i.test(line) || /panales y articulos bebes/i.test(line)) { currentSection = 'BEBES'; continue; }
      if (/pañales y articulos adultos/i.test(line) || /panales y articulos adultos/i.test(line)) { currentSection = 'ADULTOS'; continue; }
      if (/perfumeria/i.test(line)) { currentSection = 'PERFUMERIA'; continue; }

      // Header de marca
      if (isBrandHeader(line)) {
        const brand = BRANDS.find(b => b.toUpperCase() === line.toUpperCase());
        if (brand) { currentBrand = BRAND_NORMALIZE[brand] || brand; continue; }
      }

      // Extraer producto
      const extracted = extractProductFromLine(line);
      if (!extracted) continue;

      const cleanName = cleanProductName(extracted.name);
      if (cleanName.length < 6) continue;
      if (isBrandHeader(cleanName)) continue;

      const brand = currentBrand || detectBrandFromName(cleanName) || 'Sin marca';

      let category = detectCategory(cleanName);
      if (category === 'OTROS') {
        category = currentSection === 'PERFUMERIA' ? 'HIGIENE' : 'PAÑALES';
      }
      category = applyCategoryOverrides(cleanName, brand, category);

      // Markup
      const markup = category === 'HIGIENE' ? markups.markupHigiene : markups.markupPanales;
      let priceConsumer = null;
      if (extracted.price !== null) {
        priceConsumer = roundUpTo10(extracted.price * (1 + markup / 100));
      }

      // ¿Tiene talles agrupados?
      const sizeGroup = detectSizeGroup(cleanName);

      if (sizeGroup) {
        // Desglose: generar N productos
        for (let i = 0; i < sizeGroup.sizes.length; i++) {
          const size = sizeGroup.sizes[i];
          // Construir reemplazo según patrón
          // Patrón B: TALLE + 'x' + UNIDAD (preserva la cantidad de ese talle puntual)
          // Patrón A: solo TALLE
          let replacement;
          if (sizeGroup.pattern === 'B' && sizeGroup.units) {
            replacement = size + 'x' + sizeGroup.units[i];
          } else {
            replacement = size;
          }
          const canonicalName = cleanName
            .replace(sizeGroup.groupString, replacement)
            .replace(/\s+/g, ' ')
            .trim();

          const dedupeKey = canonicalName + '|' + size + '|' + extracted.price;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          products.push({
            name: canonicalName,
            cost: extracted.price,
            category, brand,
            size,
            priceConsumer,
            imageUrl: '',
            updatedAt: Date.now()
          });
        }
      } else {
        // Sin grupo: extraer talle único
        const size = extractSingleSize(cleanName);

        const dedupeKey = cleanName + '|' + size + '|' + extracted.price;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        products.push({
          name: cleanName,
          cost: extracted.price,
          category, brand,
          size,
          priceConsumer,
          imageUrl: '',
          updatedAt: Date.now()
        });
      }
    }

    return products;
  }

  /**
   * Extrae texto de un PDF preservando filas (Y-clustering).
   * Requiere pdfjsLib globalmente disponible (se carga via CDN en el HTML).
   */
  async function extractPdfLines(file, onProgress) {
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('pdf.js no está cargado');
    }
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const allLines = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      if (onProgress) onProgress(pageNum / pdf.numPages * 0.5);
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();

      const rows = {};
      for (const item of content.items) {
        const y = Math.round(item.transform[5]);
        let bucket = null;
        for (const key of Object.keys(rows)) {
          if (Math.abs(parseInt(key) - y) <= 2) { bucket = key; break; }
        }
        bucket = bucket || y;
        if (!rows[bucket]) rows[bucket] = [];
        rows[bucket].push({ x: item.transform[4], str: item.str });
      }

      const sortedY = Object.keys(rows).map(Number).sort((a, b) => b - a);
      for (const y of sortedY) {
        const items = rows[y].sort((a, b) => a.x - b.x);
        const text = items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
        if (text) allLines.push(text);
      }
    }
    return allLines;
  }

  /* ============================================================
     4. DIFF
     ============================================================ */

  function diffProducts(oldList, newList) {
    const keyOf = p => String(p.name) + '|' + String(p.size || '');

    const oldMap = {}, newMap = {};
    for (const p of oldList) oldMap[keyOf(p)] = p;
    for (const p of newList) newMap[keyOf(p)] = p;

    const added = [], removed = [], priceUp = [], priceDown = [], noStockNow = [];

    for (const k in newMap) {
      const np = newMap[k], op = oldMap[k];
      if (!op) { added.push(np); continue; }

      const npHasPrice = np.priceConsumer && np.priceConsumer > 0;
      const opHasPrice = op.priceConsumer && op.priceConsumer > 0;

      if (opHasPrice && !npHasPrice) { noStockNow.push(np); continue; }

      if (npHasPrice && opHasPrice && Number(np.cost) !== Number(op.cost) && op.cost > 0) {
        const pct = ((np.cost - op.cost) / op.cost) * 100;
        const rec = { name: np.name, size: np.size, oldCost: op.cost, newCost: np.cost, pct };
        if (np.cost > op.cost) priceUp.push(rec);
        else priceDown.push(rec);
      }
    }
    for (const k in oldMap) {
      if (!newMap[k]) removed.push(oldMap[k]);
    }

    return {
      added, removed, priceUp, priceDown, noStockNow,
      summary: {
        total: newList.length,
        added: added.length,
        removed: removed.length,
        priceUp: priceUp.length,
        priceDown: priceDown.length,
        noStock: newList.filter(p => !p.priceConsumer).length
      }
    };
  }

  /* ============================================================
     5. CLIENTE BACKEND
     ============================================================ */

  /**
   * Cliente del backend Apps Script.
   * Modos:
   *   - admin (POST + token): para admin.html
   *   - public (GET sin token): para tienda (index.html)
   */
  const api = {
    /** Llama POST con token (admin). */
    async call(url, action, payload = {}) {
      if (!url) throw new Error('URL no configurada');
      const token = payload.token || localStorage.getItem(STORAGE_KEYS.SHEETS_TOKEN);
      const body = Object.assign({ action, token }, payload);

      const res = await fetch(url, {
        method: 'POST',
        // text/plain evita preflight CORS en Apps Script
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Error desconocido');
      return data;
    },

    /** Lee productos públicos (GET sin token). Para tienda. */
    async fetchPublicProducts(url) {
      if (!url) throw new Error('URL no configurada');
      const sep = url.includes('?') ? '&' : '?';
      const res = await fetch(url + sep + 'mode=tienda', { method: 'GET' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Error desconocido');
      return data.products || [];
    },

    /** Lee config pública (GET sin token). Para tienda. */
    async fetchPublicConfig(url) {
      if (!url) throw new Error('URL no configurada');
      const sep = url.includes('?') ? '&' : '?';
      const res = await fetch(url + sep + 'mode=config', { method: 'GET' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Error desconocido');
      return data.config || {};
    },

    // Wrappers admin
    async ping(url, token)              { return this.call(url, 'PING', { token }); },
    async getProducts(url, token)       { return this.call(url, 'GET', { token }); },
    async postProducts(url, token, products, diff) { return this.call(url, 'POST', { token, products, diff }); },
    async compareProducts(url, token, products)    { return this.call(url, 'COMPARE', { token, products }); },
    async getConfig(url, token)         { return this.call(url, 'GET_CONFIG', { token }); },
    async setConfig(url, token, config) { return this.call(url, 'SET_CONFIG', { token, config }); },
    async updateProduct(url, token, product) { return this.call(url, 'UPDATE_PRODUCT', { token, product }); }
  };

  /* ============================================================
     6. FORMATEO
     ============================================================ */

  const format = {
    money(n) {
      if (n === null || n === undefined || isNaN(n)) return '—';
      return '$' + Math.round(Number(n)).toLocaleString('es-AR');
    },
    moneyShort(n) {
      if (n === null || n === undefined || isNaN(n)) return '—';
      const v = Number(n);
      if (v >= 1000000) return '$' + (v / 1000000).toFixed(1) + 'M';
      if (v >= 1000) return '$' + (v / 1000).toFixed(1) + 'k';
      return '$' + Math.round(v);
    },
    pct(n, decimals = 1) {
      if (n === null || n === undefined || isNaN(n)) return '—';
      return Number(n).toFixed(decimals) + '%';
    },
    relativeDate(timestamp) {
      if (!timestamp) return '';
      const now = Date.now();
      const diff = now - Number(timestamp);
      const day = 86400000;
      if (diff < day) return 'hoy';
      if (diff < day * 2) return 'ayer';
      if (diff < day * 7) return 'hace ' + Math.floor(diff / day) + ' días';
      const d = new Date(Number(timestamp));
      return d.toLocaleDateString('es-AR');
    },
    dateTime(timestamp) {
      if (!timestamp) return '';
      const d = new Date(Number(timestamp));
      return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
  };

  /* ============================================================
     7. CARRITO (persistente, usado solo en tienda)
     ============================================================ */

  const cart = {
    _items: null,

    _load() {
      if (this._items !== null) return;
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.CART);
        this._items = raw ? JSON.parse(raw) : [];
      } catch (e) {
        this._items = [];
      }
    },

    _save() {
      try {
        localStorage.setItem(STORAGE_KEYS.CART, JSON.stringify(this._items));
      } catch (e) {
        console.warn('No se pudo guardar carrito:', e);
      }
    },

    _key(item) {
      return String(item.name) + '|' + String(item.size || '');
    },

    items() { this._load(); return this._items.slice(); },

    count() {
      this._load();
      return this._items.reduce((sum, i) => sum + (i.qty || 0), 0);
    },

    total() {
      this._load();
      return this._items.reduce((sum, i) => sum + (Number(i.priceConsumer) || 0) * (i.qty || 0), 0);
    },

    add(product, qty = 1) {
      this._load();
      const key = this._key(product);
      const existing = this._items.find(i => this._key(i) === key);
      if (existing) {
        existing.qty = (existing.qty || 1) + qty;
      } else {
        this._items.push({
          name: product.name,
          size: product.size || '',
          brand: product.brand || '',
          category: product.category || '',
          priceConsumer: Number(product.priceConsumer) || 0,
          imageUrl: product.imageUrl || '',
          qty: qty
        });
      }
      this._save();
      this._notify();
    },

    setQty(item, qty) {
      this._load();
      const key = this._key(item);
      const existing = this._items.find(i => this._key(i) === key);
      if (existing) {
        if (qty <= 0) {
          this._items = this._items.filter(i => this._key(i) !== key);
        } else {
          existing.qty = qty;
        }
        this._save();
        this._notify();
      }
    },

    remove(item) { this.setQty(item, 0); },

    clear() {
      this._items = [];
      this._save();
      this._notify();
    },

    _listeners: [],
    onChange(fn) { this._listeners.push(fn); },
    _notify() { this._listeners.forEach(fn => { try { fn(); } catch (e) {} }); }
  };

  /* ============================================================
     8. UTILS
     ============================================================ */

  const utils = {
    /** Día de la semana del cliente (lun, mar, ...) en zona AR */
    todayDow() {
      const days = ['dom','lun','mar','mie','jue','vie','sab'];
      return days[new Date().getDay()];
    },

    /** Verifica si la promo aplica hoy según banner_dias */
    bannerActiveToday(bannerDias) {
      if (!bannerDias) return false;
      const today = this.todayDow();
      const list = String(bannerDias).toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      return list.includes(today);
    },

    /** Construye URL wa.me con mensaje pre-cargado */
    waLink(numero, mensaje) {
      const num = String(numero || '').replace(/[^\d]/g, '');
      const msg = encodeURIComponent(mensaje || '');
      return 'https://wa.me/' + num + (msg ? '?text=' + msg : '');
    },

    /** Slug para IDs CSS / claves DOM */
    slug(s) {
      return String(s).toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    },

    /** Debounce simple */
    debounce(fn, ms) {
      let t;
      return function () {
        const args = arguments, ctx = this;
        clearTimeout(t);
        t = setTimeout(() => fn.apply(ctx, args), ms);
      };
    },

    /** Toast no bloqueante (requiere CSS de .toast-container en el host) */
    toast(message, type = 'info', duration = 3500) {
      let container = document.getElementById('toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
        document.body.appendChild(container);
      }
      const t = document.createElement('div');
      t.className = 'toast toast-' + type;
      t.textContent = message;
      t.style.cssText = 'pointer-events:auto;padding:12px 20px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.18);color:#fff;font-weight:600;animation:toastIn .3s ease;max-width:90vw;';
      const colors = { info: '#7FC8E8', success: '#4CAF50', error: '#E74C3C', warn: '#F59E0B' };
      t.style.background = colors[type] || colors.info;
      if (type === 'info') t.style.color = '#1A2C36';
      container.appendChild(t);
      setTimeout(() => {
        t.style.opacity = '0';
        t.style.transform = 'translateY(10px)';
        t.style.transition = 'all .3s';
        setTimeout(() => t.remove(), 300);
      }, duration);
    }
  };

  /* ============================================================
     9. EXPORT
     ============================================================ */
  global.Pompitas = {
    VERSION,
    config: { STORAGE_KEYS, DEFAULT_MARKUPS },
    parser: {
      // bajo nivel
      parsePrice, extractProductFromLine, cleanProductName,
      detectCategory, detectBrandFromName, isBrandHeader,
      roundUpTo10, applyCategoryOverrides,
      // talles
      SIZE_TOKENS, detectSizeGroup, extractSingleSize,
      // pipeline
      parseProductsFromLines, extractPdfLines,
      // diff
      diffProducts,
      // tablas
      KEYWORDS_PANALES, KEYWORDS_HIGIENE, BRANDS, BRAND_NORMALIZE, IGNORE_PATTERNS
    },
    api,
    format,
    cart,
    utils
  };

})(typeof window !== 'undefined' ? window : this);
