/*
  Free gift (e.g. a mystery tee) — keeps the cart correct no matter how it changes.

  Rules, enforced after every cart change (theme, apps, back button):
  - Gift off, or no paid items in the cart  -> remove every gift line.
  - More than one gift line                 -> keep one.
  - Gift quantity above 1                   -> set it to 1.
  - Paid items back after the cart was
    emptied, and a size was chosen before   -> add that size again.
  - Gift not free (no discount making it $0)-> remove it, so nobody is charged,
                                               and pause the gift for 10 minutes.
  Checkout is blocked while the size dropdown is waiting for a choice.

  The gift is only $0 when a Shopify discount makes it free (for example an
  automatic "Buy X get Y" discount). This script never makes anything free.
*/
(function () {
  'use strict';

  var configEl = document.getElementById('FreeGiftConfig');
  if (!configEl || window.__freeGiftLoaded) return;
  window.__freeGiftLoaded = true;

  var config;
  try {
    config = JSON.parse(configEl.textContent);
  } catch (e) {
    return;
  }
  if (!config.productId) return;

  var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
  var offKey = 'free-gift-off:' + config.productId;
  var sizeKey = 'free-gift-size:' + config.productId;
  var offMinutes = 10;
  var nativeFetch = window.fetch.bind(window);
  var cartMutation = /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/;
  var running = null;
  var queued = false;
  var timer = null;

  // ---------------------------------------------------------------- helpers

  function isGift(item) {
    return item.product_id === config.productId;
  }

  function store(key, value) {
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, String(value));
    } catch (e) {}
  }

  function read(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  }

  function request(path, body) {
    return nativeFetch(root + path, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().then(function (json) {
        if (!res.ok) throw json;
        return json;
      });
    });
  }

  function addGift(variantId) {
    return request('cart/add.js', {
      items: [{ id: Number(variantId), quantity: 1, properties: { _free_gift: '1' } }]
    }).then(function (result) {
      store(sizeKey, variantId);
      return result;
    });
  }

  function rebuildCart() {
    document.dispatchEvent(new CustomEvent('cart:build'));
  }

  function isEditorOrPreview() {
    return !!(window.Shopify && window.Shopify.designMode) || /preview_theme_id=/.test(location.search);
  }

  // The gift is paused when it turned out not to be free. The pause ends after
  // 10 minutes so fixing the discount doesn't need a new browser session.
  function giftIsOff() {
    var until = Number(read(offKey));
    if (until && until > Date.now()) return true;
    if (until) store(offKey, null);
    return false;
  }

  function markGiftOff() {
    store(offKey, Date.now() + offMinutes * 60 * 1000);
    document.documentElement.classList.add('free-gift-off');
    var warning = 'Free gift removed from the cart: it is not $0. Set up a discount ' +
      '(e.g. automatic Buy X get Y, 100% off the gift, limit 1 per order) so it is free.';
    if (window.console) console.warn('[free-gift] ' + warning);
    if (isEditorOrPreview()) showAdminWarning(warning);
  }

  function showAdminWarning(text) {
    if (document.getElementById('FreeGiftAdminWarning')) return;
    var el = document.createElement('div');
    el.id = 'FreeGiftAdminWarning';
    el.setAttribute('role', 'alert');
    el.textContent = text + ' (Only shown in the theme editor and previews.)';
    el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;' +
      'padding:12px 16px;border-radius:8px;background:#b00020;color:#fff;font:14px/1.4 sans-serif;';
    document.body.appendChild(el);
  }

  if (giftIsOff()) document.documentElement.classList.add('free-gift-off');

  // ---------------------------------------------------------------- rules

  // One pass: read the cart and decide what to change.
  function planFor(cart) {
    var gifts = cart.items.filter(isGift);
    var paid = cart.items.reduce(function (n, item) {
      return isGift(item) ? n : n + item.quantity;
    }, 0);
    var plan = { updates: {}, add: null };

    if (!config.enabled || paid === 0) {
      gifts.forEach(function (g) { plan.updates[g.key] = 0; });
      return plan;
    }

    if (!gifts.length) {
      // Cart was emptied and refilled: give back the size they chose before.
      var size = read(sizeKey);
      if (size && !giftIsOff()) plan.add = size;
      return plan;
    }

    gifts.forEach(function (g, index) {
      if (index > 0) {
        plan.updates[g.key] = 0;
      } else if (g.quantity !== 1) {
        plan.updates[g.key] = 1;
      } else if (g.final_line_price > 0) {
        plan.updates[g.key] = 0;
        markGiftOff();
      }
    });
    return plan;
  }

  // Bring the cart in line with the rules. Repeats until nothing changes (max 4 passes).
  function reconcile() {
    if (running) {
      queued = true;
      return running;
    }
    running = (async function () {
      var changed = false;
      try {
        for (var pass = 0; pass < 4; pass++) {
          var cart = await request('cart.js');
          var plan = planFor(cart);
          if (Object.keys(plan.updates).length) {
            await request('cart/update.js', { updates: plan.updates });
            changed = true;
          } else if (plan.add) {
            try {
              await addGift(plan.add);
              changed = true;
            } catch (err) {
              store(sizeKey, null); // that size sold out: ask again
              break;
            }
          } else {
            break;
          }
        }
      } catch (e) {
        // Leave the cart as it is. The discount still decides the price at checkout.
      }
      return changed;
    })().then(function (changed) {
      running = null;
      if (changed) rebuildCart();
      if (queued) {
        queued = false;
        return reconcile();
      }
      return changed;
    });
    return running;
  }

  function scheduleReconcile() {
    clearTimeout(timer);
    timer = setTimeout(reconcile, 150);
  }

  // Watch every cart change made by the theme or by apps (fetch and XHR).
  window.fetch = function (input, init) {
    var url = String((input && input.url) || input || '');
    var promise = nativeFetch(input, init);
    if (cartMutation.test(url)) {
      promise.then(scheduleReconcile, scheduleReconcile);
    }
    return promise;
  };

  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (cartMutation.test(String(url))) {
      this.addEventListener('loadend', scheduleReconcile);
    }
    return xhrOpen.apply(this, arguments);
  };

  // ---------------------------------------------------------------- UI

  function showMessage(scope, text) {
    var el = scope && scope.querySelector('[data-free-gift-message]');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  function errorText(err) {
    return (err && err.status === 422) ? config.soldOutText : config.errorText;
  }

  document.addEventListener('change', function (event) {
    // Size dropdown in the picker: add the chosen size.
    var pick = event.target.closest('[data-free-gift-select]');
    if (pick) {
      var box = pick.closest('[data-free-gift-picker]');
      var chosen = pick.value;
      if (!chosen) return;
      if (box) box.classList.add('is-loading');
      showMessage(box, '');

      addGift(chosen)
        .then(function () { return reconcile(); })
        .then(rebuildCart)
        .catch(function (err) {
          // Cart unchanged: keep the picker on screen and say why.
          if (box) box.classList.remove('is-loading');
          var option = pick.querySelector('option[value="' + chosen + '"]');
          if (err && err.status === 422 && option) option.disabled = true;
          pick.value = '';
          showMessage(box, errorText(err));
        });
      return;
    }

    // Size dropdown on the gift line: swap sizes. Adds the new size before
    // removing the old one, so a failed request never leaves them without a gift.
    var swap = event.target.closest('[data-free-gift-swap]');
    if (!swap) return;
    var line = swap.closest('[data-free-gift-line]');
    var newId = swap.value;
    if (Number(newId) === Number(swap.dataset.current)) return;
    if (line) line.classList.add('is-loading');
    showMessage(line, '');

    addGift(newId)
      .then(function () { return request('cart/change.js', { id: swap.dataset.key, quantity: 0 }); })
      .then(function () { return reconcile(); })
      .then(rebuildCart)
      .catch(function (err) {
        if (line) line.classList.remove('is-loading');
        var option = swap.querySelector('option[value="' + newId + '"]');
        if (err && err.status === 422 && option) option.disabled = true;
        swap.value = swap.dataset.current;
        store(sizeKey, swap.dataset.current);
        showMessage(line, errorText(err));
        reconcile();
      });
  });

  // Block checkout while a size still needs choosing.
  function pendingPicker(from) {
    if (!config.enabled || !config.requireSize) return null;
    if (document.documentElement.classList.contains('free-gift-off')) return null;
    var form = from && from.closest('form');
    return (form && form.querySelector('[data-free-gift-pending]')) ||
      document.querySelector('[data-free-gift-pending]');
  }

  function blockCheckout(event, picker) {
    event.preventDefault();
    event.stopImmediatePropagation();
    picker.classList.add('free-gift--attention');
    showMessage(picker, config.requiredText);
    picker.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var select = picker.querySelector('[data-free-gift-select]');
    if (select) select.focus();
    document.querySelectorAll('.cart__checkout').forEach(function (btn) {
      btn.classList.remove('btn--loading');
    });
  }

  document.addEventListener('click', function (event) {
    var trigger = event.target.closest('[name="checkout"], .cart__checkout, a[href*="/checkout"]');
    if (!trigger) return;
    var picker = pendingPicker(trigger);
    if (picker) blockCheckout(event, picker);
  }, true);

  document.addEventListener('submit', function (event) {
    var submitter = event.submitter;
    if (!submitter || submitter.name !== 'checkout') return;
    var picker = pendingPicker(submitter);
    if (picker) blockCheckout(event, picker);
  }, true);

  // Check the cart on load and when the page comes back from the back button.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { reconcile(); });
  } else {
    reconcile();
  }
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) reconcile().then(rebuildCart);
  });
})();
