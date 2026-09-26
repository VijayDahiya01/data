// Small conveniences only: every page works without this script.
(function () {
  'use strict';

  // Show only the fields that apply to the chosen kind of database.
  var kind = document.getElementById('kind');
  if (kind) {
    var sets = document.querySelectorAll('fieldset[data-kinds]');
    var show = function () {
      sets.forEach(function (set) {
        var on = set.getAttribute('data-kinds').split(' ').indexOf(kind.value) >= 0;
        set.hidden = !on;
        set.disabled = !on;
      });
    };
    kind.addEventListener('change', show);
    show();
  }

  // Changing a column choice re-checks the page, so its numbers and examples
  // always describe what is selected.
  document.querySelectorAll('[data-recheck]').forEach(function (el) {
    el.addEventListener('change', function () {
      var form = el.form;
      if (!form) return;
      var action = document.createElement('input');
      action.type = 'hidden';
      action.name = 'action';
      action.value = 'check';
      form.appendChild(action);
      form.submit();
    });
  });
})();
