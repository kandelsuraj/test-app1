/*
 * Makes calculated items behave in pieces in the cart.
 *
 * A calculated line is stored as `quantity x unit price` (e.g. 4500 x $0.01),
 * so the theme would show 4500 in the quantity box and the cart bubble, and its
 * +/- buttons would change the price by one cent. For those lines this shows
 * pieces instead, and turns the buttons into piece changes: the quantity is
 * recalculated from the stored per-piece price and the `_calculator` and pieces
 * properties are rewritten to match. Checkout re-prices from `_calculator`
 * anyway, so nothing done here can change what the customer is charged.
 *
 * The theme's cart form posts quantities positionally as `updates[]`, so the
 * real quantity is kept in a hidden `updates[]` input at the same spot; the
 * visible box loses its name and never gets submitted.
 */
(function () {
  'use strict';

  var MARK = 'calcCart';
  var QUANTITY_INPUTS = 'input[name="updates[]"]';
  var CONTROL = 'quantity-input, .quantity, [data-quantity-selector]';
  var BUBBLES = '.cart-count-bubble, [data-cart-count]';

  var PENDING = 'price-calc-pending';

  var lines = new WeakMap();
  var cartRequest = 0;
  // Last known cart, starting with the one the app embed rendered into the page.
  var cart = readEmbeddedCart();

  function readEmbeddedCart() {
    var node = document.getElementById('price-calc-cart');
    try {
      return node ? JSON.parse(node.textContent) : null;
    } catch (error) {
      return null;
    }
  }

  function root() {
    var routes = window.Shopify && window.Shopify.routes;
    return (routes && routes.root) || '/';
  }

  function fetchCart() {
    return fetch(root() + 'cart.js', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (response) { return response.json(); });
  }

  function calculation(item) {
    var raw = item && item.properties && item.properties._calculator;
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      data.pieces = parseInt(data.pieces, 10) > 0 ? parseInt(data.pieces, 10) : 1;
      return data;
    } catch (error) {
      return null;
    }
  }

  /** Items the customer thinks they bought: pieces for calculated lines. */
  function countItems(cart) {
    return (cart.items || []).reduce(function (sum, item) {
      var data = calculation(item);
      return sum + (data ? data.pieces : item.quantity);
    }, 0);
  }

  function piecesLabelFor(item, data) {
    if (data.piecesLabel) return data.piecesLabel;
    // Added before the label was recorded; only the default label is safe to guess.
    return item.properties && item.properties.Pieces !== undefined ? 'Pieces' : null;
  }

  function maxPiecesFor(item, data) {
    if (data.maxPieces) return Math.max(1, parseInt(data.maxPieces, 10) || 1);
    return piecesLabelFor(item, data) ? 100 : 1;
  }

  /* ---------- Display ---------- */

  function setBubble(bubble, count) {
    bubble.dataset[MARK] = '1';

    var shown = bubble.querySelector('span[aria-hidden="true"]');
    var hidden = bubble.querySelector('.visually-hidden');
    if (!shown && !hidden) {
      bubble.textContent = String(count);
    } else {
      if (!shown) {
        // Dawn leaves the number out once the quantity reaches 100.
        shown = document.createElement('span');
        shown.setAttribute('aria-hidden', 'true');
        bubble.insertBefore(shown, bubble.firstChild);
      }
      shown.textContent = count < 100 ? String(count) : '99+';
      if (hidden) hidden.textContent = hidden.textContent.replace(/\d+/, String(count));
    }
    // Remembered so a theme rewriting the number in place can be spotted.
    bubble.dataset.calcShown = bubble.textContent;
  }

  /** Bubbles to (re)do: new ones, and ones whose number the theme overwrote. */
  function bubblesToFix() {
    return Array.prototype.slice.call(document.querySelectorAll(BUBBLES)).filter(function (bubble) {
      if (!bubble.dataset[MARK]) return true;
      var ours = bubble.dataset.calcShown;
      if (ours === undefined || bubble.textContent === ours) return false;

      // The theme refreshed the count itself, so whatever cart we hold may be
      // older than its number: hide it and fetch before relabelling.
      delete bubble.dataset[MARK];
      delete bubble.dataset.calcShown;
      bubble.dataset.calcStale = '1';
      return true;
    });
  }

  function buttonsOf(input) {
    var control = input.closest(CONTROL);
    return control ? Array.prototype.slice.call(control.querySelectorAll('button')) : [];
  }

  function isMinus(button, input) {
    var name = (button.getAttribute('name') || '').toLowerCase();
    if (name === 'minus') return true;
    if (name === 'plus') return false;
    // Otherwise assume the usual layout: minus before the box, plus after.
    return Boolean(button.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function setButtonState(button, disabled) {
    button.disabled = disabled;
    button.classList.toggle('disabled', disabled);
    button.setAttribute('aria-disabled', String(disabled));
  }

  function refreshButtons(input, busy) {
    var line = lines.get(input);
    buttonsOf(input).forEach(function (button) {
      var atLimit = isMinus(button, input) ? line.pieces <= 1 : line.pieces >= line.max;
      setButtonState(button, busy || atLimit);
    });
  }

  function enhance(input, item, index) {
    var data = calculation(item);
    input.dataset[MARK] = data ? '1' : 'skip';
    if (!data) return;

    var real = document.createElement('input');
    real.type = 'hidden';
    real.name = input.name;
    real.value = String(item.quantity);
    if (input.hasAttribute('form')) real.setAttribute('form', input.getAttribute('form'));
    input.parentNode.insertBefore(real, input);

    var max = maxPiecesFor(item, data);
    lines.set(input, { item: item, data: data, line: index, pieces: data.pieces, max: max });

    input.removeAttribute('name');
    input.value = String(data.pieces);
    input.min = '1';
    input.max = String(max);
    input.setAttribute('aria-label', piecesLabelFor(item, data) || 'Pieces');
    if (max <= 1) {
      input.readOnly = true;
      input.setAttribute('aria-readonly', 'true');
    }
    refreshButtons(input, false);
  }

  /** The 1-based cart line an input belongs to. */
  function lineFor(input, position) {
    var explicit = parseInt(input.getAttribute('data-index') || input.getAttribute('data-line'), 10);
    return explicit > 0 ? explicit : position + 1;
  }

  function setPending(element, on) {
    element.classList.toggle(PENDING, on);
    var control = element.closest(CONTROL);
    if (control) control.classList.toggle(PENDING, on);
  }

  /** Whether the bubble shows this count; text nodes are read one by one, as
   * adjacent spans run together in textContent. */
  function showsCount(bubble, count) {
    var walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      var match = /\d+/.exec(walker.currentNode.data);
      if (match && Number(match[0]) === count) return true;
    }
    return false;
  }

  /**
   * Relabels any quantity box or bubble not handled yet. Runs synchronously
   * from the mutation observer, so when the known cart matches what the theme
   * just rendered, the raw quantity never gets painted. When it might not match
   * (the theme changed the cart itself), the element shows a skeleton until a
   * fresh cart arrives.
   */
  function apply(fresh) {
    var inputs = Array.prototype.slice.call(document.querySelectorAll(QUANTITY_INPUTS))
      .filter(function (input) { return !input.dataset[MARK] && input.type !== 'hidden'; });
    var bubbles = bubblesToFix();
    if (!inputs.length && !bubbles.length) return;

    var items = (cart && cart.items) || [];
    var waiting = false;

    // updates[] is positional per form, so number lines within each form. Every
    // line keeps exactly one named updates[] input (our hidden one once handled).
    var groups = new Map();
    inputs.forEach(function (input) {
      var group = input.form || document;
      if (!groups.has(group)) {
        groups.set(group, Array.prototype.slice.call(group.querySelectorAll(QUANTITY_INPUTS)));
      }
      var index = lineFor(input, groups.get(group).indexOf(input));
      var item = items[index - 1];
      var variant = input.getAttribute('data-quantity-variant-id');
      var sameLine = item && (!variant || String(item.variant_id) === variant);

      if (sameLine && (fresh || Number(input.value) === item.quantity)) {
        setPending(input, false);
        enhance(input, item, index);
      } else if (fresh) {
        setPending(input, false);
        input.dataset[MARK] = 'skip';
      } else {
        setPending(input, true);
        waiting = true;
      }
    });

    var calculated = items.some(calculation);
    bubbles.forEach(function (bubble) {
      var stale = bubble.dataset.calcStale === '1';
      if (cart && (fresh || (!stale && showsCount(bubble, cart.item_count)))) {
        setPending(bubble, false);
        delete bubble.dataset.calcStale;
        if (calculated) {
          setBubble(bubble, countItems(cart));
        } else {
          // Still watched, in case the theme later counts a calculated item.
          bubble.dataset[MARK] = '1';
          bubble.dataset.calcShown = bubble.textContent;
        }
      } else {
        setPending(bubble, true);
        waiting = true;
      }
    });

    if (waiting) refresh();
  }

  function refresh() {
    // Only the newest request counts: one sent before the theme's own update
    // finished would bring back the old count.
    var request = ++cartRequest;
    fetchCart()
      .then(function (latest) {
        if (request !== cartRequest) return;
        cart = latest;
        apply(true);
      })
      .catch(function (error) {
        console.warn('[price-calculator] could not read the cart:', error);
        // Show the theme's own numbers rather than a skeleton forever.
        Array.prototype.slice.call(document.querySelectorAll(QUANTITY_INPUTS + ',' + BUBBLES))
          .forEach(function (element) {
            if (element.dataset[MARK]) return;
            setPending(element, false);
            element.dataset[MARK] = 'skip';
          });
      });
  }

  /* ---------- Changing pieces ---------- */

  function showLineError(input, message) {
    var row = input.closest('.cart-item, tr, li');
    var node = row && row.querySelector('.cart-item__error-text');
    if (node) {
      node.textContent = message;
      var wrapper = node.closest('.cart-item__error');
      if (wrapper) wrapper.classList.remove('hidden');
    } else {
      console.warn('[price-calculator] ' + message);
    }
  }

  /** Swap in freshly rendered sections the way Dawn-style themes do. */
  function renderSections(host, sections, rendered) {
    if (!rendered) return false;
    return sections.every(function (section) {
      var html = rendered[section.section];
      var target = document.getElementById(section.id);
      if (!html || !target) return !target;

      var source = new DOMParser().parseFromString(html, 'text/html').querySelector(section.selector);
      var destination = target.querySelector(section.selector) || target;
      if (!source) return false;
      destination.innerHTML = source.innerHTML;
      return true;
    });
  }

  function setPieces(input, requested) {
    var line = lines.get(input);
    if (!line || line.busy) return;

    var pieces = Math.min(Math.max(Math.floor(Number(requested)) || 1, 1), line.max);
    if (pieces === line.pieces) {
      input.value = String(line.pieces);
      return;
    }

    var data = line.data;
    var unitCents = Math.round(Number(data.unit) * 100) || line.item.price;
    var perPieceCents = Math.round(Number(data.perPiece) * 100);
    if (!unitCents || !perPieceCents) {
      input.value = String(line.pieces);
      return showLineError(input, 'Remove this item and add it again to change the amount.');
    }

    var quantity = Math.max(1, Math.round((perPieceCents * pieces) / unitCents));
    var properties = {};
    Object.keys(line.item.properties || {}).forEach(function (key) {
      properties[key] = line.item.properties[key];
    });
    var label = piecesLabelFor(line.item, data);
    if (label) properties[label] = String(pieces);
    properties._calculator = JSON.stringify(Object.assign({}, data, {
      pieces: pieces,
      price: (quantity * unitCents) / 100
    }));

    var host = input.closest('cart-items, cart-drawer-items');
    var sections = host && typeof host.getSectionsToRender === 'function' ? host.getSectionsToRender() : [];
    var body = { line: line.line, quantity: quantity, properties: properties };
    if (sections.length) {
      body.sections = sections.map(function (section) { return section.section; });
      body.sections_url = window.location.pathname;
    }

    line.busy = true;
    input.value = String(pieces);
    input.setAttribute('aria-busy', 'true');
    refreshButtons(input, true);

    fetch(root() + 'cart/change.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok) throw new Error(result.description || result.message || 'Could not update the cart.');
          return result;
        });
      })
      .then(function (result) {
        // The response is the new cart, so the re-rendered lines match it and
        // can be relabelled before they are painted.
        if (result.items) cart = result;
        if (!renderSections(host, sections, result.sections)) window.location.reload();
      })
      .catch(function (error) {
        line.busy = false;
        input.value = String(line.pieces);
        input.removeAttribute('aria-busy');
        refreshButtons(input, false);
        showLineError(input, error.message);
      });
  }

  function lockedInputFor(target) {
    var control = target.closest && target.closest(CONTROL);
    var input = control && control.querySelector('input[data-calc-cart="1"]');
    return input && lines.has(input) ? input : null;
  }

  // Capture phase, so the theme's own handlers never see these events: they
  // would send the pieces number to the cart as a raw quantity.
  document.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('button');
    var input = button && lockedInputFor(button);
    if (!input) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (button.disabled) return;

    var line = lines.get(input);
    setPieces(input, line.pieces + (isMinus(button, input) ? -1 : 1));
  }, true);

  ['input', 'change'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      var input = event.target;
      if (!lines.has(input)) return;
      event.stopImmediatePropagation();
      if (type === 'change') setPieces(input, input.value);
    }, true);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || !lines.has(event.target)) return;
    // Enter would submit the cart form; apply the typed pieces instead.
    event.preventDefault();
    setPieces(event.target, event.target.value);
  }, true);

  /* ---------- Startup ---------- */

  function run() {
    apply(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }

  // Themes re-render the cart, drawer and bubble after every change. Observer
  // callbacks run before the next paint, which is what keeps 4500 off screen.
  // characterData catches themes that set the bubble's text node in place.
  new MutationObserver(run).observe(document.documentElement, { childList: true, characterData: true, subtree: true });
})();
