/*
 * Kebda Zaman Legal Site — language switching only.
 * No analytics, no tracking, no external requests.
 * Uses localStorage solely to remember the visitor's chosen language.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "kz-legal-lang";
  var SUPPORTED = ["en", "ar"];

  function detectLanguage() {
    try {
      var saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved && SUPPORTED.indexOf(saved) !== -1) {
        return saved;
      }
    } catch (err) {
      /* localStorage unavailable (private mode, etc.) — fall back below */
    }

    var browserLang = (navigator.language || navigator.userLanguage || "en").toLowerCase();
    return browserLang.indexOf("ar") === 0 ? "ar" : "en";
  }

  function applyLanguage(lang) {
    var dir = lang === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;

    var buttons = document.querySelectorAll("[data-setlang]");
    for (var i = 0; i < buttons.length; i++) {
      var isActive = buttons[i].getAttribute("data-setlang") === lang;
      buttons[i].setAttribute("aria-pressed", isActive ? "true" : "false");
    }
  }

  function setLanguage(lang) {
    if (SUPPORTED.indexOf(lang) === -1) {
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch (err) {
      /* ignore — language still applies for this view */
    }
    applyLanguage(lang);
  }

  function markCurrentNavLink() {
    var currentPath = window.location.pathname.split("/").pop() || "index.html";
    var links = document.querySelectorAll(".site-nav a[href]");
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute("href");
      if (href === currentPath) {
        links[i].setAttribute("aria-current", "page");
      }
    }
  }

  function wireCopyButtons() {
    var buttons = document.querySelectorAll("[data-copy-target]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", function (event) {
        var targetId = event.currentTarget.getAttribute("data-copy-target");
        var target = document.getElementById(targetId);
        if (!target) {
          return;
        }
        var text = target.textContent.trim();
        var button = event.currentTarget;
        var restore = function () {
          setTimeout(function () {
            button.textContent = button.getAttribute("data-copy-label");
          }, 1600);
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard
            .writeText(text)
            .then(function () {
              button.textContent = button.getAttribute("data-copied-label");
              restore();
            })
            .catch(function () {
              /* clipboard permission denied — text remains selectable manually */
            });
        }
      });
    }
  }

  function wireLangButtons() {
    var buttons = document.querySelectorAll("[data-setlang]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", function (event) {
        setLanguage(event.currentTarget.getAttribute("data-setlang"));
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    applyLanguage(detectLanguage());
    wireLangButtons();
    wireCopyButtons();
    markCurrentNavLink();
  });
})();
