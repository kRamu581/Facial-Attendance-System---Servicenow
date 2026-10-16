(function() {
  data.success = false;
  data.message = "";

  if (!input || !input.action) {
    return;
  }

  var REG_TABLE = "u_face_registration";
  var ATT_TABLE = "u_attendance";

  var MATCH_THRESHOLD = 0.50;      // lower = stricter
  var LATE_HOUR = 9;               // late after 09:30 (user's local time)
  var LATE_MINUTE = 30;
  var MIN_CHECKOUT_GAP_MS = 60000; // at least 1 minute after check-in

  function parseDescriptor(raw) {
    var arr;
    try {
      arr = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!Array.isArray(arr) || arr.length !== 128) {
      return null;
    }
    for (var i = 0; i < arr.length; i++) {
      if (typeof arr[i] !== "number" || !isFinite(arr[i])) {
        return null;
      }
    }
    return arr;
  }

  function distance(a, b) {
    var sum = 0;
    for (var i = 0; i < 128; i++) {
      var d = a[i] - b[i];
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  // ---------------- REGISTER ----------------
  if (input.action === "register") {
    var email = (input.email || "").toString().trim().toLowerCase();
    var name = (input.name || "").toString().trim();

    if (!name) {
      data.message = "Name is required.";
      return;
    }
    if (!isValidEmail(email)) {
      data.message = "Enter a valid email address.";
      return;
    }
    if (String(input.consent) !== "true") {
      data.message = "Consent is required to store face data.";
      return;
    }

    var descriptor = parseDescriptor(input.descriptor);
    if (!descriptor) {
      data.message = "Invalid face descriptor.";
      return;
    }

    var existing = new GlideRecord(REG_TABLE);
    existing.addQuery("u_email", email);
    existing.setLimit(1);
    existing.query();
    if (existing.hasNext()) {
      data.message = "This email is already registered.";
      return;
    }

    // Stop the same face being registered under a second email.
    var all = new GlideRecord(REG_TABLE);
    all.query();
    while (all.next()) {
      var saved = parseDescriptor(all.getValue("u_descriptor"));
      if (saved && distance(descriptor, saved) < MATCH_THRESHOLD) {
        data.message = "This face is already registered as " + all.getValue("u_name") + ".";
        return;
      }
    }

    var gr = new GlideRecord(REG_TABLE);
    gr.initialize();
    gr.setValue("u_name", name);
    gr.setValue("u_email", email);
    gr.setValue("u_descriptor", JSON.stringify(descriptor));

    if (gr.insert()) {
      data.success = true;
      data.message = "Registration successful.";
    } else {
      data.message = "Could not save the registration.";
    }
    return;
  }

  // ---------------- MARK ATTENDANCE ----------------
  if (input.action === "mark") {
    var type = input.type === "checkout" ? "checkout" : "checkin";

    var current = parseDescriptor(input.descriptor);
    if (!current) {
      data.message = "Invalid face descriptor.";
      return;
    }

    // 1:N matching: find the closest registered face.
    var best = null;
    var bestDist = 999;
    var reg = new GlideRecord(REG_TABLE);
    reg.query();
    while (reg.next()) {
      var s = parseDescriptor(reg.getValue("u_descriptor"));
      if (!s) {
        continue;
      }
      var dist = distance(current, s);
      if (dist < bestDist) {
        bestDist = dist;
        best = {
          name: reg.getValue("u_name"),
          email: reg.getValue("u_email")
        };
      }
    }

    if (!best || bestDist >= MATCH_THRESHOLD) {
      data.message = "Face not recognized.";
      data.distance = bestDist < 999 ? bestDist.toFixed(3) : "";
      return;
    }

    var now = new GlideDateTime();
    var today = now.getLocalDate().getValue();

    var att = new GlideRecord(ATT_TABLE);
    att.addQuery("u_email", best.email);
    att.addQuery("u_date", today);
    att.setLimit(1);
    att.query();
    var hasToday = att.next();

    data.name = best.name;
    data.distance = bestDist.toFixed(3);

    if (type === "checkin") {
      if (hasToday) {
        data.success = true;
        data.status = att.getValue("u_status");
        data.time = att.getDisplayValue("u_check_in");
        data.message = "Already checked in today.";
        return;
      }

      var hour = parseInt(now.getHourLocalTime(), 10);
      var minute = parseInt(now.getMinutesLocalTime(), 10);
      var isLate = hour > LATE_HOUR || (hour === LATE_HOUR && minute > LATE_MINUTE);

      var rec = new GlideRecord(ATT_TABLE);
      rec.initialize();
      rec.setValue("u_name", best.name);
      rec.setValue("u_email", best.email);
      rec.setValue("u_date", today);
      rec.setValue("u_check_in", now.getValue());
      rec.setValue("u_status", isLate ? "Late" : "Present");
      rec.setValue("u_distance", bestDist.toFixed(3));

      if (rec.insert()) {
        data.success = true;
        data.status = isLate ? "Late" : "Present";
        data.time = now.getDisplayValue();
        data.message = "Checked in.";
      } else {
        data.message = "Could not save attendance.";
      }
      return;
    }

    // check out
    if (!hasToday) {
      data.message = "No check-in found for today.";
      return;
    }

    var checkIn = new GlideDateTime(att.getValue("u_check_in"));
    var gap = GlideDateTime.subtract(checkIn, now).getNumericValue();
    if (gap < MIN_CHECKOUT_GAP_MS) {
      data.message = "Too soon to check out.";
      return;
    }

    att.setValue("u_check_out", now.getValue());
    att.update();

    data.success = true;
    data.status = att.getValue("u_status");
    data.time = now.getDisplayValue();
    data.message = "Checked out.";
    return;
  }

  data.message = "Unknown action.";
})();
