/*
  Free gift (e.g. a mystery tee) — keeps the cart correct no matter how it changes.

  Rules, enforced after every cart change (theme, apps, other tabs on return):
  - Gift off, or no paid items in the cart  -> remove every gift line.
  - More than one gift line                 -> keep one.
  - Gift quantity above 1                   -> set it to 1.
  - Gift not free (discount inactive)       -> remove it and hide the picker
                                               for this browser session.
  Checkout is blocked while the size picker is waiting for a choice.

  The real guarantee is the Shopify automatic discount: it only makes ONE gift
  free, and only alongside a paid item. This script keeps the cart tidy and the
  experience clear; it never makes anything free on its own.
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
  var nativeFetch = window.fetch.bind(window);
  var cartMutation = /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/;
  var running = null;
  var queued = false;
  var timer = null;

  function isGift(item) {
    return item.product_id === config.productId;
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
        if (!res.ok || json.status >= 400) throw json;
        return json;
      });
    });
  }

  function giftIsOff() {
    try { return sessionStorage.getItem(offKey) === '1'; } catch (e) { return false; }
  }

  function markGiftOff() {
    try { sessionStorage.setItem(offKey, '1'); } catch (e) {}
    document.documentElement.classList.add('free-gift-off');
  }

  if (giftIsOff()) document.documentElement.classList.add('free-gift-off');

  function rebuildCart() {
    document.dispatchEvent(new CustomEvent('cart:build'));
  }

  // One pass: read the cart and work out which gift lines to change.
  function planFor(cart) {
    var gifts = cart.items.filter(isGift);
    var paid = cart.items.reduce(function (n, item) {
      return isGift(item) ? n : n + item.quantity;
    }, 0);
    var updates = {};

    if (!config.enabled || paid === 0) {
      gifts.forEach(function (g) { updates[g.key] = 0; });
      return updates;
    }

    gifts.forEach(function (g, index) {
      if (index > 0) {
        updates[g.key] = 0;
      } else if (g.quantity !== 1) {
        updates[g.key] = 1;
      } else if (g.final_line_price > 0) {
        // Exactly one gift and it still costs money: the discount isn't on.
        updates[g.key] = 0;
        markGiftOff();
      }
    });
    return updates;
  }

  // Bring the cart in line with the rules. Repeats until nothing changes (max 3 passes).
  function reconcile() {
    if (running) {
      queued = true;
      return running;
    }
    running = (async function () {
      var changed = false;
      try {
        for (var pass = 0; pass < 3; pass++) {
          var cart = await request('cart.js');
          var updates = planFor(cart);
          if (!Object.keys(updates).length) break;
          await request('cart/update.js', { updates: updates });
          changed = true;
        }
      } catch (e) {
        // Leave the cart as it is: the discount still protects the price.
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

  function showMessage(scope, text) {
    var el = scope && scope.querySelector('[data-free-gift-message]');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  // Size picker: add the chosen size.
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-free-gift-add]');
    if (!button) return;
    event.preventDefault();
    if (button.disabled) return;

    var box = button.closest('[data-free-gift-picker]');
    if (box) box.classList.add('is-loading');
    showMessage(box, '');

    request('cart/add.js', {
      items: [{ id: Number(button.dataset.freeGiftAdd), quantity: 1, properties: { _free_gift: '1' } }]
    })
      .then(function () { return reconcile(); })
      .then(rebuildCart)
      .catch(function (err) {
        if (box) box.classList.remove('is-loading');
        showMessage(box, (err && err.status === 422) ? config.soldOutText : config.errorText);
        rebuildCart();
      });
  });

  // Gift line: change size. Adds the new size before removing the old one,
  // so a failed request never leaves the customer without their gift.
  document.addEventListener('change', function (event) {
    var select = event.target.closest('[data-free-gift-swap]');
    if (!select) return;

    var line = select.closest('[data-free-gift-line]');
    var newId = Number(select.value);
    var oldKey = select.dataset.key;
    if (newId === Number(select.dataset.current)) return;

    if (line) line.classList.add('is-loading');
    showMessage(line, '');

    request('cart/add.js', {
      items: [{ id: newId, quantity: 1, properties: { _free_gift: '1' } }]
    })
      .then(function () { return request('cart/change.js', { id: oldKey, quantity: 0 }); })
      .catch(function (err) {
        if (line) line.classList.remove('is-loading');
        select.value = select.dataset.current;
        showMessage(line, (err && err.status === 422) ? config.soldOutText : config.errorText);
      })
      .then(function () { return reconcile(); })
      .then(rebuildCart);
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

  // Check the cart on load and when the page is restored from the back button.
  function onReady() {
    reconcile();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) reconcile().then(rebuildCart);
  });
})();
