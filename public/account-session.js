/* Display caches must not survive a real account switch on a shared browser. */
(function () {
  function cookie(name) {
    var match = document.cookie.split('; ').find(function (s) { return s.indexOf(name + '=') === 0; });
    return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
  }
  var owner = cookie('mp_account_id');
  if (!owner) return;
  try {
    if (localStorage.getItem('accountCacheOwner') !== owner) {
      localStorage.clear(); sessionStorage.clear(); localStorage.setItem('accountCacheOwner', owner);
    }
    localStorage.setItem('marcoTaskUser', cookie('mp_account'));
  } catch (_) {}
  window.addEventListener('storage', function (event) {
    if (event.key === 'accountCacheOwner' && event.newValue !== owner) location.reload();
  });
  window.addEventListener('pageshow', function (event) {
    if (event.persisted || cookie('mp_account_id') !== owner) location.reload();
  });
})();
