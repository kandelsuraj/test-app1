/*
 * Redirects checkout to an app-built draft order when the cart holds calculated
 * items.
 *
 * Design note: this is a client-side interception, so it can be bypassed (by
 * navigating straight to /checkout, for example). That is deliberate and safe —
 * calculated lines are added to the cart as `quantity x unit price`, so the
 * bypassed path still charges the right amount. This layer exists to make the
 * order tidy, not to make it correct.
 */
(function () {
  'use strict';

  var script = document.currentScript || document.querySelector('[data-price-calc-checkout]');
  if (!script) return;

  var ENDPOINT = script.getAttribute('data-endpoint') || '/apps/calculator/checkout';
  var STATUS_ENDPOINT = script.getAttribute('data-status-endpoint') || '/apps/calculator/checkout-status';
  var BUSY_LABEL = script.getAttribute('data-busy-label') || '';

  /*
   * A draft order checkout is separate from the cart, so paying for it leaves
   * the cart full. The checkout being handed off is remembered here, and later
   * visits ask the app whether it was paid; if so, its lines leave the cart.
   */
  var PENDING_KEY = 'priceCalcPendingCheckout';
  // Matches the app deleting open drafts after 7 days.
  var PENDING_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
  var PENDING_CHECK_EVERY = 60 * 1000;

  // Anything a theme plausibly uses to leave the cart for checkout.
  var TRIGGERS = [
    '[name="checkout"]',
    'a[href="/checkout"]',
    'a[href$="/checkout"]',
    'a[href*="/checkout?"]',
    '[data-price-calc-checkout-button]'
  ].join(',');

  var busy = false;

  function closest(element, selector) {
    if (!element || !element.closest) return null;
    return element.closest(selector);
  }

  function hasCalculatedItems(cart) {
    return (cart.items || []).some(function (item) {
      return item.properties && item.properties._calculator;
    });
  }

  function toPayload(cart) {
    return {
      items: (cart.items || []).map(function (item) {
        return {
          variantId: item.variant_id,
          productId: item.product_id,
          quantity: item.quantity,
          properties: item.properties || {}
        };
      })
    };
  }

  function setBusy(trigger, on) {
    if (!BUSY_LABEL) return;

    if (on) {
      if (trigger.dataset.calcLabel === undefined) {
        trigger.dataset.calcLabel = trigger.textContent;
      }
      trigger.textContent = BUSY_LABEL;
    } else if (trigger.dataset.calcLabel !== undefined) {
      trigger.textContent = trigger.dataset.calcLabel;
      delete trigger.dataset.calcLabel;
    }
  }

  function root() {
    return (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
  }

  // Storage can be missing or throw (private windows, blocked site data); the
  // cart just isn't emptied automatically then.
  function readPending() {
    try {
      return JSON.parse(window.localStorage.getItem(PENDING_KEY) || 'null');
    } catch (error) {
      return null;
    }
  }

  function writePending(pending) {
    try {
      if (pending) window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
      else window.localStorage.removeItem(PENDING_KEY);
    } catch (error) {
      // Nothing to do; see readPending.
    }
  }

  function rememberCheckout(ticket, cart) {
    if (!ticket) return;
    writePending({
      ticket: ticket,
      keys: (cart.items || []).map(function (item) { return item.key; }),
      at: Date.now(),
      checkedAt: 0
    });
  }

  /** Removes the paid lines that are still in the cart; true if any were. */
  function removePaidLines(keys) {
    return fetch(root() + 'cart.js', { headers: { Accept: 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (cart) {
        var updates = {};
        (cart.items || []).forEach(function (item) {
          // Only lines exactly as they were paid for; anything added or
          // re-configured since stays in the cart.
          if (keys.indexOf(item.key) !== -1) updates[item.key] = 0;
        });
        if (!Object.keys(updates).length) return false;

        return fetch(root() + 'cart/update.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ updates: updates })
        }).then(function (response) {
          if (!response.ok) throw new Error('cart update returned ' + response.status);
          return true;
        });
      });
  }

  function checkPendingCheckout() {
    var pending = readPending();
    if (!pending || !pending.ticket) return;

    if (Date.now() - pending.at > PENDING_MAX_AGE) {
      writePending(null);
      return;
    }
    if (Date.now() - (pending.checkedAt || 0) < PENDING_CHECK_EVERY) return;

    pending.checkedAt = Date.now();
    writePending(pending);

    fetch(STATUS_ENDPOINT + '?ticket=' + encodeURIComponent(pending.ticket), {
      headers: { Accept: 'application/json' }
    })
      .then(function (response) { return response.json(); })
      .then(function (result) {
        if (result.status === 'COMPLETED') {
          return removePaidLines(pending.keys || []).then(function (removed) {
            writePending(null);
            // The page was drawn with the old cart; show the emptied one.
            if (removed) window.location.reload();
          });
        }
        // Deleted drafts will never be paid; open ones might still be.
        if (result.status === 'GONE') writePending(null);
        return null;
      })
      .catch(function (error) {
        console.warn('[price-calculator] could not check the last checkout:', error);
      });
  }

  /** Let the original control do its normal thing, just this once. */
  function fallThrough(trigger) {
    trigger.dataset.calcBypass = '1';
    setBusy(trigger, false);

    if (trigger.tagName === 'A' && trigger.href) {
      window.location.href = trigger.href;
    } else {
      trigger.click();
    }
  }

  function handle(trigger) {
    busy = true;
    setBusy(trigger, true);
    var checkoutCart = null;

    fetch(root() + 'cart.js', { headers: { Accept: 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (cart) {
        checkoutCart = cart;
        if (!hasCalculatedItems(cart)) {
          busy = false;
          fallThrough(trigger);
          return null;
        }

        var started = Date.now();
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(toPayload(cart))
        }).then(function (response) {
          return response.text().then(function (text) {
            var reply = {
              status: response.status,
              type: response.headers.get('Content-Type') || 'no content type',
              ms: Date.now() - started,
              data: null
            };
            try {
              reply.data = JSON.parse(text);
            } catch (error) {
              // Usually Shopify's own error page: the app proxy gave up
              // waiting for the app, or could not reach it at all.
              reply.text = text.slice(0, 500);
            }
            return reply;
          });
        });
      })
      .then(function (reply) {
        if (!reply) return;

        if (reply.data && reply.data.invoiceUrl) {
          rememberCheckout(reply.data.ticket, checkoutCart);
          window.location.href = reply.data.invoiceUrl;
          return;
        }

        console.warn(
          '[price-calculator] falling back to normal checkout. The app replied ' +
            reply.status + ' (' + reply.type + ') after ' + reply.ms + 'ms: ' +
            (reply.data
              ? (reply.data.error || 'no checkout link in the reply')
              : 'not JSON, so probably a Shopify app proxy error page. Start of reply:'),
          reply.data ? '' : reply.text
        );

        busy = false;
        fallThrough(trigger);
      })
      .catch(function (error) {
        console.warn('[price-calculator] falling back to normal checkout:', error);
        busy = false;
        fallThrough(trigger);
      });
  }

  document.addEventListener(
    'click',
    function (event) {
      if (busy) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      var trigger = closest(event.target, TRIGGERS);
      if (!trigger) return;

      // Our own re-dispatch, or a control we already gave up on.
      if (trigger.dataset.calcBypass === '1') {
        delete trigger.dataset.calcBypass;
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      handle(trigger);
    },
    true
  );

  checkPendingCheckout();
})();
