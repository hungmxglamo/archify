    /* ============================================================
       Sequence Details — open a step to read the detail steps inside a
       block right after it. The renderer stores each step's detail markup,
       where it starts (data-seq-base) and its height. Opening a step inserts
       that markup and moves every later part down by the height: parts tagged
       data-seq-y move, parts tagged data-seq-from / data-seq-to stretch, and
       the viewBox grows. Closing the step puts everything back.
       ============================================================ */
    Archify.sequenceDetails = (function () {
      var svg = document.querySelector('.diagram-container > svg');
      var sources = svg ? svg.querySelectorAll('[data-seq-detail-source]') : [];
      if (!sources.length) return { active: false };
      var SVG_NS = 'http://www.w3.org/2000/svg';
      var viewBox = svg.viewBox.baseVal;
      var baseWidth = viewBox.width;
      var baseHeight = viewBox.height;
      var steps = Object.create(null);
      Array.prototype.forEach.call(sources, function (source) {
        steps[source.getAttribute('data-seq-detail-source')] = {
          base: Number(source.getAttribute('data-seq-base')),
          height: Number(source.getAttribute('data-seq-height')),
          markup: source.getAttribute('data-seq-markup') || '',
          open: false,
          block: null
        };
      });

      // How far a point at y moves down: the heights of open steps above it.
      function shiftAt(y) {
        var shift = 0;
        Object.keys(steps).forEach(function (id) {
          var step = steps[id];
          if (step.open && step.base < y) shift += step.height;
        });
        return shift;
      }

      function createBlock(id, step) {
        var block = document.createElementNS(SVG_NS, 'g');
        block.setAttribute('data-seq-detail-block', id);
        block.innerHTML = step.markup;
        var message = svg.querySelector('[data-edge-key="' + id + '"]');
        if (message && message.parentNode) message.parentNode.insertBefore(block, message.nextSibling);
        else svg.appendChild(block);
        return block;
      }

      function moveParts() {
        Array.prototype.forEach.call(svg.querySelectorAll('[data-seq-y]'), function (el) {
          var shift = shiftAt(Number(el.getAttribute('data-seq-y')));
          if (shift) el.setAttribute('transform', 'translate(0 ' + shift + ')');
          else el.removeAttribute('transform');
        });
        Array.prototype.forEach.call(svg.querySelectorAll('[data-seq-from]'), function (el) {
          var from = Number(el.getAttribute('data-seq-from'));
          var to = Number(el.getAttribute('data-seq-to'));
          var top = from + shiftAt(from);
          var bottom = to + shiftAt(to);
          if (el.tagName.toLowerCase() === 'path') {
            var x = (el.getAttribute('d') || '').match(/M\s*(-?[\d.]+)/);
            if (x) el.setAttribute('d', 'M ' + x[1] + ' ' + top + ' L ' + x[1] + ' ' + bottom);
          } else {
            el.setAttribute('y', top);
            el.setAttribute('height', Math.max(0, bottom - top));
          }
        });
      }

      function apply() {
        var total = 0;
        Object.keys(steps).forEach(function (id) {
          var step = steps[id];
          if (step.open && !step.block) step.block = createBlock(id, step);
          if (!step.open && step.block) {
            step.block.parentNode.removeChild(step.block);
            step.block = null;
          }
          if (step.block) {
            var shift = shiftAt(step.base);
            step.block.setAttribute('transform', 'translate(0 ' + shift + ')');
          }
          if (step.open) total += step.height;
          Array.prototype.forEach.call(svg.querySelectorAll('[data-seq-detail-toggle="' + id + '"]'), function (toggle) {
            toggle.setAttribute('aria-expanded', step.open ? 'true' : 'false');
            if (step.open) toggle.setAttribute('data-seq-open', '');
            else toggle.removeAttribute('data-seq-open');
          });
        });
        moveParts();
        svg.setAttribute('viewBox', '0 0 ' + baseWidth + ' ' + (baseHeight + total));
        window.dispatchEvent(new Event('resize'));
      }

      function setOpen(id, value) {
        if (!steps[id]) return false;
        steps[id].open = Boolean(value);
        apply();
        return true;
      }

      function activate(event) {
        var target = event.target.closest('[data-seq-detail-toggle]');
        if (!target || !svg.contains(target)) return false;
        event.preventDefault();
        event.stopPropagation();
        var id = target.getAttribute('data-seq-detail-toggle');
        setOpen(id, !steps[id].open);
        target.focus();
        return true;
      }

      // Capture phase so the canvas focus handler never treats a toggle press
      // as a background click that clears the current focus.
      svg.addEventListener('click', activate, true);
      svg.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') activate(event);
      }, true);

      return {
        active: true,
        open: function (id) { return setOpen(id, true); },
        close: function (id) { return setOpen(id, false); },
        openAll: function () {
          Object.keys(steps).forEach(function (id) { steps[id].open = true; });
          apply();
        },
        closeAll: function () {
          Object.keys(steps).forEach(function (id) { steps[id].open = false; });
          apply();
        },
        openIds: function () {
          return Object.keys(steps).filter(function (id) { return steps[id].open; });
        }
      };
    })();
