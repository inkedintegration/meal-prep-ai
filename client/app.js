/* The conversation is the app. Thin client: chat + cards. All intelligence lives in the edge function. */
(function () {
  var CFG = window.MEAL_CONFIG;
  var thread = document.getElementById("thread");
  var draft = document.getElementById("draft");
  var sendBtn = document.getElementById("send");

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

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
        var s = el("span", "score", "chef score: " + r.quality_score + "/100");
        c.appendChild(s);
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
      if (p2.notes) bits.push(p2.notes);
      c.appendChild(el("p", "meta", bits.length ? bits.join(" · ") : "Profile saved."));
      thread.appendChild(c);
    }
    thread.scrollTop = thread.scrollHeight;
  }

  var busy = false;
  function send() {
    var text = draft.value.trim();
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
      body: JSON.stringify({ message: text }),
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
  draft.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  addBubble("assistant", "Hey. This is your kitchen taking shape. Tell me what you have, what you love, and what weeknights look like. The planning brain arrives next; nothing you say is lost.");
})();
