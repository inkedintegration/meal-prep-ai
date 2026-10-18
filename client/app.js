/* The conversation is the app. Thin client: chat + cards. All intelligence lives in the edge function. */
(function () {
  var CFG = window.MEAL_CONFIG;
  var thread = document.getElementById("thread");
  var draft = document.getElementById("draft");
  var sendBtn = document.getElementById("send");
  var quickBtn = document.getElementById("quick-plan");

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function addBubble(role, text) {
    var b = el("div", "bubble " + role, text);
    thread.appendChild(b);
    thread.scrollTop = thread.scrollHeight;
    return b;
  }

  function addNotice(text) {
    var b = el("div", "bubble notice", text);
    thread.appendChild(b);
    thread.scrollTop = thread.scrollHeight;
  }

  function renderCard(card) {
  // ---------- exports: plain text you can paste anywhere ----------
  function copyText(text, label) {
    var done = function () { addNotice("Copied: " + label); };
    var fallback = function () { addNotice("Copy did not go through on this device; long-press the text instead."); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { fallback(); }
      ta.remove();
    }
  }
  function copyBtn(text, label) {
    var b = el("button", "ghost copy-btn", "Copy");
    b.addEventListener("click", function () { copyText(text(), label); });
    return b;
  }
  function head(h3, metaText, buildCopy) {
    var row = el("div", "card-head");
    var left = el("div", null);
    left.appendChild(el("h3", null, h3));
    if (metaText) left.appendChild(el("p", "meta", metaText));
    row.appendChild(left);
    if (buildCopy) row.appendChild(buildCopy);
    return row;
  }

    var c = el("div", "card");
    if (card.type === "pantry_review" && card.items) {
      c.appendChild(el("h3", null, "Pantry check"));
      c.appendChild(el("p", "meta", "Everything below is saved, marked unconfirmed. Confirm or correct in chat."));
      var ul = el("ul");
      card.items.forEach(function (it) {
        ul.appendChild(el("li", null, (it.quantity ? it.quantity + " " : "") + (it.raw_text || "")));
      });
      c.appendChild(ul);
      thread.appendChild(c);
    } else if (card.type === "recipe" && card.recipe) {
      var r = card.recipe;
      c.appendChild(el("h3", null, r.title));
      if (r.quality_score != null) {
        c.appendChild(el("span", "score", "chef score: " + r.quality_score + "/100"));
      }
      c.appendChild(el("p", "meta", (r.ingredients_count || 0) + " ingredients, " + (r.steps_count || 0) + " steps" + (r.servings ? ", serves " + r.servings : "")));
      if (r.quality_notes && r.quality_notes.length) {
        c.appendChild(el("p", "meta", r.quality_notes.slice(0, 3).join(" · ")));
      }
      var p = el("p", "meta");
      var a = document.createElement("a");
      a.href = r.source_url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "source: " + (r.attribution || "linked recipe");
      p.appendChild(a);
      c.appendChild(p);
      thread.appendChild(c);
    } else if (card.type === "week_context" && card.constraints) {
      c.appendChild(el("h3", null, "This week"));
      c.appendChild(el("p", "meta", "Kept with the plan:"));
      var wl = el("ul");
      card.constraints.forEach(function (ct) {
        wl.appendChild(el("li", null, cap(ct.day) + ": " + ct.note));
      });
      c.appendChild(wl);
      thread.appendChild(c);
    } else if (card.type === "week_plan" && card.days) {
      var weekText = "THIS WEEK" + (card.week_of ? " (" + card.week_of + ")" : "") + "\n\n" +
        card.days.map(function (d) {
          return cap(d.day) + ":\n" + d.meals.map(function (m) {
            return "  · " + m.slot + ": " + m.title + (m.servings ? " (serves " + m.servings + ")" : "") + (m.note ? " — " + m.note : "");
          }).join("\n");
        }).join("\n\n");
      c.appendChild(head("This week's plan", null, copyBtn(function () { return weekText; }, "this week's plan")));
      var wul = el("ul");
      card.days.forEach(function (d) {
        d.meals.forEach(function (m) {
          wul.appendChild(el("li", null, cap(d.day) + " (" + m.slot + "): " + m.title + (m.servings ? ", serves " + m.servings : "") + (m.note ? " · " + m.note : "")));
        });
      });
      c.appendChild(wul);
      thread.appendChild(c);
    } else if (card.type === "shopping_list" && card.items) {
      var listMeta = card.items.length + " to buy" + (card.skipped_have ? " · " + card.skipped_have + " already in your kitchen" : "");
      var listText = "SHOPPING LIST\n\n" + card.items.map(function (it) {
        return "· " + (it.quantity ? it.quantity + " " : "") + (it.raw_text || "");
      }).join("\n");
      c.appendChild(head("Shopping list", listMeta, copyBtn(function () { return listText; }, "the shopping list")));
      var sul = el("ul");
      card.items.forEach(function (it) {
        sul.appendChild(el("li", null, (it.quantity ? it.quantity + " " : "") + (it.raw_text || "")));
      });
      c.appendChild(sul);
      thread.appendChild(c);
    } else if (card.type === "cook_guide" && card.tasks) {
      var cookText = "COOK DAY: " + cap(card.day) + "\n" + (card.focus ? card.focus + "\n\n" : "\n") +
        card.tasks.map(function (t, i) {
          return (i + 1) + ". " + t.text + (t.minutes ? " (" + t.minutes + " min)" : "");
        }).join("\n");
      c.appendChild(head("Cook day: " + cap(card.day), card.focus || null, copyBtn(function () { return cookText; }, "the cook day guide")));
      var ol = el("ol");
      card.tasks.forEach(function (t) {
        ol.appendChild(el("li", null, t.text + (t.minutes ? " (" + t.minutes + " min)" : "")));
      });
      c.appendChild(ol);
      thread.appendChild(c);
    } else if (card.type === "plan_stub") {
      c.appendChild(el("h3", null, "One-tap week"));
      c.appendChild(el("p", "meta", "Coming in milestone 3. Your week notes are already saved."));
      thread.appendChild(c);
    } else if (card.type === "notice") {
      thread.appendChild(el("div", "bubble notice", card.text || ""));
    } else if (card.type === "profile" && card.profile) {
      c.appendChild(el("h3", null, "Your kitchen profile"));
      var bits = [];
      var p2 = card.profile;
      (p2.dietary_restrictions || []).forEach(function (x) { bits.push(x); });
      (p2.allergies || []).forEach(function (x) { bits.push("allergy: " + x); });
      (p2.cuisines_loved || []).forEach(function (x) { bits.push("loves " + x); });
      (p2.cuisines_avoided || []).forEach(function (x) { bits.push("skips " + x); });
      (p2.disliked_ingredients || []).forEach(function (x) { bits.push("no " + x); });
      if (p2.household_size) bits.push("household of " + p2.household_size);
      if (p2.time_budget_minutes) bits.push(p2.time_budget_minutes + " min cook days");
      (p2.rhythms || []).forEach(function (x) { bits.push(x.subject + " (" + x.kind + ")"); });
      if (p2.notes) bits.push(p2.notes);
      c.appendChild(el("p", "meta", bits.length ? bits.join(" · ") : "Profile saved."));
      thread.appendChild(c);
    }
    thread.scrollTop = thread.scrollHeight;
  }

  var busy = false;
  function send(cmd, bubbleText) {
    var text = cmd ? String(bubbleText ?? "") : draft.value.trim();
    if (!text || busy) return;
    busy = true;
    sendBtn.disabled = true;
    addBubble("user", text);
    draft.value = "";
    var typing = el("div", "typing", "thinking…");
    thread.appendChild(typing);
    thread.scrollTop = thread.scrollHeight;

    fetch(CFG.edgeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-token": CFG.appToken },
      body: JSON.stringify(cmd ? { command: cmd, message: text } : { message: text }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        typing.remove();
        if (data.error === "missing_key") {
          addNotice("The chef brain is asleep: its OpenRouter key is not set yet. Juno will flip this switch.");
          addBubble("assistant", "Your words still got through to me: I am here, just not planning yet.");
          return;
        }
        if (data.error) {
          addBubble("assistant", data.message || "Something went sideways. Try again?");
          return;
        }
        addBubble("assistant", data.reply || "Okay.");
        (data.cards || []).forEach(renderCard);
      })
      .catch(function () {
        typing.remove();
        addNotice("Could not reach the kitchen. Check your connection and try again.");
      })
      .finally(function () {
        busy = false;
        sendBtn.disabled = false;
        draft.focus();
      });
  }

  sendBtn.addEventListener("click", send);

  // ---------- photo import: fridge shot or grocery receipt -> pantry ----------
  var photoBtn = document.getElementById("photo");
  var photoInput = document.getElementById("photo-input");
  function sendPhoto(dataUrl, name) {
    if (busy) { addNotice("One thing at a time: the kitchen is still thinking."); return; }
    busy = true;
    sendBtn.disabled = true;
    addBubble("user", "📷 " + (name || "photo"));
    var typing = el("div", "typing", "reading the photo…");
    thread.appendChild(typing);
    thread.scrollTop = thread.scrollHeight;
    fetch(CFG.edgeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-token": CFG.appToken },
      body: JSON.stringify({ command: { type: "scan_photo", image: dataUrl }, message: "what food is in this photo" }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        typing.remove();
        if (data.error === "missing_key") {
          addNotice("The photo brain needs its OpenRouter key; it is not set yet. Juno will flip this switch.");
          return;
        }
        if (data.error) {
          addNotice(data.message || "The photo did not scan. Try a brighter, closer shot.");
          return;
        }
        addBubble("assistant", data.reply || "Okay.");
        (data.cards || []).forEach(renderCard);
      })
      .catch(function () {
        typing.remove();
        addNotice("Could not reach the kitchen. Check your connection and try again.");
      })
      .finally(function () {
        busy = false;
        sendBtn.disabled = false;
      });
  }
  if (photoBtn && photoInput) {
    photoBtn.addEventListener("click", function () { photoInput.click(); });
    photoInput.addEventListener("change", function () {
      var f = photoInput.files && photoInput.files[0];
      photoInput.value = "";
      if (!f) return;
      if (!/^image\//.test(f.type || "")) { addNotice("That file is not an image; a fridge or receipt photo works best."); return; }
      var img = new Image();
      var url = URL.createObjectURL(f);
      img.onload = function () {
        var scale = Math.min(1, 1024 / Math.max(img.width, img.height));
        var cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(img.width * scale));
        cv.height = Math.max(1, Math.round(img.height * scale));
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        sendPhoto(cv.toDataURL("image/jpeg", 0.8), f.name);
      };
      img.onerror = function () { URL.revokeObjectURL(url); addNotice("Could not read that image. Try a different photo."); };
      img.src = url;
    });
  }

  if (quickBtn) {
    quickBtn.addEventListener("click", function () {
      draft.value = "plan my week";
      send();
    });
  }
  draft.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // ---------- your kitchen profile ----------
  var sheet = document.getElementById("profile-sheet");
  var profileBtn = document.getElementById("quick-profile");
  var lastProfile = null;
  var lastCounts = null;

  function fmtList(arr) { return (arr && arr.length) ? arr.join(", ") : "none yet"; }

  function profileRows(p) {
    return [
      ["Household", p.household_size ? p.household_size + " people" : "not set yet"],
      ["Dietary restrictions", fmtList(p.dietary_restrictions)],
      ["Allergies", fmtList(p.allergies)],
      ["Cuisines we love", fmtList(p.cuisines_loved)],
      ["Cuisines to skip", fmtList(p.cuisines_avoided)],
      ["Ingredients nobody likes", fmtList(p.disliked_ingredients)],
      ["Non-negotiables", fmtList(p.non_negotiables)],
      ["Weekly rhythms", (p.rhythms && p.rhythms.length) ? p.rhythms.map(function (r) { return r.subject; }).join("; ") : "none yet"]
    ];
  }

  function renderProfileSets(sets) {
    var holder = document.getElementById("profile-sets");
    holder.innerHTML = "";
    var title = el("p", "pf-meta", "Profiles: tap to switch. The one in use is what plans are built from; edits above change it.");
    holder.appendChild(title);
    (sets || []).forEach(function (s) {
      var btn = el("button", "pf-slot" + (s.is_current ? " current" : ""), s.name + (s.is_current ? " · in use" : ""));
      btn.addEventListener("click", function () {
        if (s.is_current) return;
        sheet.hidden = true;
        send({ type: "switch_profile", name: s.name }, "switch to " + s.name.toLowerCase());
      });
      holder.appendChild(btn);
    });
  }
  function loadProfile() {
    var view = document.getElementById("profile-view");
    view.innerHTML = "";
    document.getElementById("profile-edit").hidden = true;
    document.getElementById("profile-form").hidden = true;
    fetch(CFG.edgeUrl, { headers: { "x-app-token": CFG.appToken } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        lastProfile = d.profile || {};
        lastCounts = { pantry: d.pantry_count, recipes: d.recipe_count };
        profileRows(lastProfile).forEach(function (row) {
          var n = el("p", "pf-row");
          var b = document.createElement("b");
          b.textContent = row[0] + ": ";
          n.appendChild(b);
          n.appendChild(document.createTextNode(row[1]));
          view.appendChild(n);
        });
        var m = el("p", "pf-meta");
        m.textContent = "It also knows: " + (lastCounts.pantry || 0) + " pantry items and " + (lastCounts.recipes || 0) + " saved recipes.";
        view.appendChild(m);
        renderProfileSets(d.profiles || []);
        document.getElementById("profile-edit").hidden = false;
      })
      .catch(function () {
        view.appendChild(el("p", "pf-row", "Could not load your profile just now. Try again in a moment."));
      });
  }

  function fillForm(p) {
    document.getElementById("pf-size").value = p.household_size || "";
    document.getElementById("pf-restrictions").value = (p.dietary_restrictions || []).join(", ");
    document.getElementById("pf-allergies").value = (p.allergies || []).join(", ");
    document.getElementById("pf-loved").value = (p.cuisines_loved || []).join(", ");
    document.getElementById("pf-avoided").value = (p.cuisines_avoided || []).join(", ");
    document.getElementById("pf-disliked").value = (p.disliked_ingredients || []).join(", ");
    document.getElementById("pf-nn").value = (p.non_negotiables || []).join(", ");
    document.getElementById("pf-rhythms").value = (p.rhythms || []).map(function (r) { return r.subject; }).join("; ");
  }

  function composeProfileMessage() {
    var bits = [];
    var size = document.getElementById("pf-size").value.trim();
    if (size) bits.push("household of " + size);
    var pairs = [
      ["dietary restrictions", "pf-restrictions"],
      ["allergies", "pf-allergies"],
      ["cuisines we love", "pf-loved"],
      ["cuisines to skip", "pf-avoided"],
      ["nobody likes", "pf-disliked"],
      ["non-negotiables", "pf-nn"],
      ["rhythms", "pf-rhythms"]
    ];
    pairs.forEach(function (pair) {
      var v = document.getElementById(pair[1]).value.trim();
      if (v) bits.push(pair[0] + ": " + v);
    });
    return bits.length ? "Update our kitchen profile: " + bits.join("; ") + "." : "";
  }

  function composeProfilePatch() {
    var patch = {};
    var size = document.getElementById("pf-size").value.trim();
    if (size) patch.household_size = Number(size);
    var map = [
      ["dietary_restrictions", "pf-restrictions"],
      ["allergies", "pf-allergies"],
      ["cuisines_loved", "pf-loved"],
      ["cuisines_avoided", "pf-avoided"],
      ["disliked_ingredients", "pf-disliked"],
      ["non_negotiables", "pf-nn"]
    ];
    map.forEach(function (pair) {
      var v = document.getElementById(pair[1]).value.trim();
      if (v) patch[pair[0]] = v.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    });
    var r = document.getElementById("pf-rhythms").value.trim();
    if (r) patch.rhythms = r.split(";").map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) { return { kind: "weekly", subject: s, detail: s }; });
    return patch;
  }

  if (profileBtn) {
    profileBtn.addEventListener("click", function () {
      sheet.hidden = false;
      loadProfile();
    });
  }
  document.getElementById("profile-close").addEventListener("click", function () { sheet.hidden = true; });
  sheet.addEventListener("click", function (e) { if (e.target === sheet) sheet.hidden = true; });
  document.getElementById("profile-edit").addEventListener("click", function () {
    fillForm(lastProfile || {});
    document.getElementById("profile-view").hidden = true;
    document.getElementById("profile-edit").hidden = true;
    document.getElementById("profile-form").hidden = false;
  });
  document.getElementById("profile-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var msg = composeProfileMessage();
    if (!msg) return;
    document.getElementById("profile-view").hidden = false;
    document.getElementById("profile-form").hidden = true;
    sheet.hidden = true;
    // exact command: no parser involved
    var patch = composeProfilePatch();
    send(Object.keys(patch).length ? { type: "set_profile", patch: patch } : null, msg);
  });

  addBubble("assistant", "Hey. This is your kitchen taking shape. Tell me what you have, what you love, and what weeknights look like. Tap Plan my week when you're curious; nothing you say is lost.");
})();
