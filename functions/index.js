// functions/index.js
// v5 - Multi-event support: data scoped under sessions/{sid}/events/{eventId}
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
admin.initializeApp();

// Helper: get the active event ref for a session
async function getActiveEventRef(db, sessionId) {
  const sessionRef = db.collection('sessions').doc(sessionId);
  const sessionSnap = await sessionRef.get();
  let eventId = sessionSnap.exists ? sessionSnap.data().active_event : null;
  if (!eventId) {
    // No active event — create the first one automatically
    eventId = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    await sessionRef.set({
      active_event: eventId,
      event_index: 1,
      show_reactions: false
    }, { merge: true });
    // Create the event doc
    await sessionRef.collection('events').doc(eventId).set({
      event_id: eventId,
      name: `Event 1 — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
      created_at: FieldValue.serverTimestamp(),
      attendee_count: 0,
      participant_count: 0
    });
  }
  return { sessionRef, eventRef: sessionRef.collection('events').doc(eventId), eventId };
}

// --- REGISTER ATTENDEE ---
exports.registerAttendee = onRequest(async (request, response) => {
  response.set('Access-Control-Allow-Origin', '*');
  if (request.method === 'OPTIONS') {
    response.set('Access-Control-Allow-Methods', 'POST');
    response.set('Access-Control-Allow-Headers', 'Content-Type');
    response.set('Access-control-max-age', '3600');
    response.status(204).send('');
    return;
  }
  if (request.method !== 'POST') { response.status(405).send('Method Not Allowed'); return; }

  const { session_id, anonymous_id } = request.body;
  if (!session_id || !anonymous_id) {
    response.status(400).send('Missing session_id or anonymous_id.');
    return;
  }

  const db = getFirestore();

  try {
    const { eventRef } = await getActiveEventRef(db, session_id);
    const participantRef = eventRef.collection('participants').doc(anonymous_id);

    await db.runTransaction(async (transaction) => {
      const participantSnap = await transaction.get(participantRef);
      if (!participantSnap.exists) {
        transaction.set(participantRef, {
          anonymous_id,
          reaction_count: 0,
          registered_at: FieldValue.serverTimestamp()
        });
        transaction.set(eventRef, {
          attendee_count: FieldValue.increment(1)
        }, { merge: true });
      }
    });
    // Return the active event ID so the client can scope its listeners
    const eventId = eventRef.id;
    response.status(200).json({ status: 'registered', event_id: eventId });
  } catch (error) {
    logger.error('registerAttendee failed:', error);
    response.status(500).send('Error registering attendee.');
  }
});

// --- ADD REACTION ---
exports.addReaction = onRequest(async (request, response) => {
  response.set('Access-Control-Allow-Origin', '*');
  if (request.method === 'OPTIONS') {
    response.set('Access-Control-Allow-Methods', 'POST');
    response.set('Access-Control-Allow-Headers', 'Content-Type');
    response.set('Access-control-max-age', '3600');
    response.status(204).send('');
    return;
  }
  if (request.method !== 'POST') { response.status(405).send('Method Not Allowed'); return; }

  const { session_id, event_id, utterance_guid, reaction_type, text, language, anonymous_id } = request.body;
  if (!session_id || !utterance_guid || !reaction_type) {
    response.status(400).send('Missing session_id, utterance_guid, or reaction_type.');
    return;
  }

  const db = getFirestore();

  try {
    const sessionRef = db.collection('sessions').doc(session_id);

    // Use provided event_id or fall back to active_event
    let resolvedEventId = event_id;
    if (!resolvedEventId) {
      const sessionSnap = await sessionRef.get();
      resolvedEventId = sessionSnap.exists ? sessionSnap.data().active_event : null;
    }
    if (!resolvedEventId) {
      response.status(400).send('No active event for session.');
      return;
    }

    const eventRef = sessionRef.collection('events').doc(resolvedEventId);
    const utteranceRef = eventRef.collection('utterances').doc(utterance_guid);
    const participantRef = eventRef.collection('participants').doc(anonymous_id || 'anonymous');

    const dedupeId = anonymous_id
      ? `${anonymous_id}_${utterance_guid}_${reaction_type.codePointAt(0)}`
      : null;
    const userReactionRef = dedupeId
      ? eventRef.collection('user_reactions').doc(dedupeId)
      : null;

    await db.runTransaction(async (transaction) => {
      const utteranceSnap = await transaction.get(utteranceRef);
      const participantSnap = anonymous_id ? await transaction.get(participantRef) : null;

      if (userReactionRef) {
        const existingReaction = await transaction.get(userReactionRef);
        if (existingReaction.exists) return;
      }

      if (!utteranceSnap.exists) {
        if (!text || !language) throw new Error('New utterance missing text/language.');
        transaction.set(utteranceRef, {
          text, language,
          first_seen_at: FieldValue.serverTimestamp(),
          last_reacted_at: FieldValue.serverTimestamp(),
          reaction_thumbs_up:   reaction_type === '👍' ? 1 : 0,
          reaction_thumbs_down: reaction_type === '👎' ? 1 : 0,
          reaction_heart:       reaction_type === '❤️' ? 1 : 0,
          reaction_thinking:    reaction_type === '🤔' ? 1 : 0,
          reaction_question:    reaction_type === '❓' ? 1 : 0,
        });
      } else {
        const updateData = { last_reacted_at: FieldValue.serverTimestamp() };
        if (reaction_type === '👍') updateData.reaction_thumbs_up   = FieldValue.increment(1);
        if (reaction_type === '👎') updateData.reaction_thumbs_down = FieldValue.increment(1);
        if (reaction_type === '❤️') updateData.reaction_heart       = FieldValue.increment(1);
        if (reaction_type === '🤔') updateData.reaction_thinking    = FieldValue.increment(1);
        if (reaction_type === '❓') updateData.reaction_question    = FieldValue.increment(1);
        transaction.update(utteranceRef, updateData);
      }

      if (userReactionRef) {
        transaction.set(userReactionRef, {
          anonymous_id, utterance_guid, reaction_type,
          timestamp: FieldValue.serverTimestamp()
        });
      }

      if (anonymous_id && participantSnap) {
        if (!participantSnap.exists) {
          transaction.set(participantRef, {
            anonymous_id,
            reaction_count: 1,
            registered_at: FieldValue.serverTimestamp()
          });
          transaction.set(eventRef, {
            attendee_count: FieldValue.increment(1),
            participant_count: FieldValue.increment(1)
          }, { merge: true });
        } else {
          const wasReactor = (participantSnap.data().reaction_count || 0) > 0;
          transaction.update(participantRef, {
            reaction_count: FieldValue.increment(1)
          });
          if (!wasReactor) {
            transaction.set(eventRef, {
              participant_count: FieldValue.increment(1)
            }, { merge: true });
          }
        }
      }
    });

    response.status(200).send('Reaction recorded.');
  } catch (error) {
    logger.error('Transaction failed:', error);
    response.status(500).send('Error writing to database.');
  }
});

// --- SEND MESSAGE (individual) ---
exports.sendMessage = onCall({ cors: true }, async (request) => {
  const { sessionId, eventId, userId, message, persistent, link } = request.data;
  if (!sessionId || !userId || !message) {
    throw new HttpsError('invalid-argument', 'sessionId, userId, and message are required.');
  }
  const db = getFirestore();

  // Resolve eventId
  let resolvedEventId = eventId;
  if (!resolvedEventId) {
    const snap = await db.collection('sessions').doc(sessionId).get();
    resolvedEventId = snap.exists ? snap.data().active_event : null;
  }
  if (!resolvedEventId) throw new HttpsError('not-found', 'No active event.');

  const msgData = { message, persistent: persistent === true, timestamp: FieldValue.serverTimestamp() };
  if (link) msgData.link = link;

  await db.collection('sessions').doc(sessionId)
    .collection('events').doc(resolvedEventId)
    .collection('participants').doc(userId)
    .collection('messages').add(msgData);

  return { status: 'success' };
});

// --- SEND BROADCAST ---
exports.sendBroadcast = onCall({ cors: true }, async (request) => {
  const { sessionId, eventId, message, persistent, engagedOnly, link } = request.data;
  if (!sessionId || !message) {
    throw new HttpsError('invalid-argument', 'sessionId and message are required.');
  }
  const db = getFirestore();

  let resolvedEventId = eventId;
  if (!resolvedEventId) {
    const snap = await db.collection('sessions').doc(sessionId).get();
    resolvedEventId = snap.exists ? snap.data().active_event : null;
  }
  if (!resolvedEventId) return { status: 'success', sent: 0 };

  const participantsSnap = await db.collection('sessions').doc(sessionId)
    .collection('events').doc(resolvedEventId)
    .collection('participants').get();

  if (participantsSnap.empty) return { status: 'success', sent: 0 };

  const docs = engagedOnly
    ? participantsSnap.docs.filter(d => (d.data().reaction_count || 0) > 0)
    : participantsSnap.docs;

  if (docs.length === 0) return { status: 'success', sent: 0 };

  const msgData = { message, persistent: persistent === true, timestamp: FieldValue.serverTimestamp() };
  if (link) msgData.link = link;

  const batch = db.batch();
  docs.forEach(doc => {
    const msgRef = db.collection('sessions').doc(sessionId)
      .collection('events').doc(resolvedEventId)
      .collection('participants').doc(doc.id)
      .collection('messages').doc();
    batch.set(msgRef, msgData);
  });
  await batch.commit();

  return { status: 'success', sent: docs.length };
});

// --- NEW EVENT ---
// Archives current event and starts a fresh one under the same session ID
exports.newEvent = onCall({ cors: true }, async (request) => {
  const { sessionId, eventName } = request.data;
  if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId is required.');

  const db = getFirestore();
  const sessionRef = db.collection('sessions').doc(sessionId);
  const sessionSnap = await sessionRef.get();
  const currentIndex = sessionSnap.exists ? (sessionSnap.data().event_index || 1) : 1;
  const nextIndex = currentIndex + 1;

  // Build new event ID from timestamp
  const newEventId = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  const newEventName = eventName && eventName.trim()
    ? eventName.trim()
    : `Event ${nextIndex} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  await sessionRef.collection('events').doc(newEventId).set({
    event_id: newEventId,
    name: newEventName,
    created_at: FieldValue.serverTimestamp(),
    attendee_count: 0,
    participant_count: 0
  });

  await sessionRef.set({
    active_event: newEventId,
    event_index: nextIndex,
    show_reactions: false
  }, { merge: true });

  logger.info(`New event created: ${newEventId} (${newEventName}) for session ${sessionId}`);
  return { status: 'success', event_id: newEventId, event_name: newEventName };
});

// --- RESET SESSION ---
// Now deletes a single event (or all events if no eventId provided)
exports.resetSession = onCall({ cors: true }, async (request) => {
  const { sessionId, eventId } = request.data;
  if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId is required.');

  const db = getFirestore();
  const sessionRef = db.collection('sessions').doc(sessionId);

  if (eventId) {
    // Delete a specific event only
    const eventRef = sessionRef.collection('events').doc(eventId);
    const participantsSnap = await eventRef.collection('participants').get();
    for (const pDoc of participantsSnap.docs) {
      await deleteCollection(pDoc.ref.collection('messages'));
      await pDoc.ref.delete();
    }
    await deleteCollection(eventRef.collection('utterances'));
    await deleteCollection(eventRef.collection('user_reactions'));
    await eventRef.delete();
  } else {
    // Nuke entire session (all events)
    const eventsSnap = await sessionRef.collection('events').get();
    for (const eDoc of eventsSnap.docs) {
      const participantsSnap = await eDoc.ref.collection('participants').get();
      for (const pDoc of participantsSnap.docs) {
        await deleteCollection(pDoc.ref.collection('messages'));
        await pDoc.ref.delete();
      }
      await deleteCollection(eDoc.ref.collection('utterances'));
      await deleteCollection(eDoc.ref.collection('user_reactions'));
      await eDoc.ref.delete();
    }
    await sessionRef.delete();
  }

  logger.info(`Reset session: ${sessionId} event: ${eventId || 'ALL'}`);
  return { status: 'success' };
});

async function deleteCollection(collectionRef, batchSize = 100) {
  const snapshot = await collectionRef.limit(batchSize).get();
  if (snapshot.empty) return;
  const batch = collectionRef.firestore.batch();
  snapshot.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  if (snapshot.size === batchSize) await deleteCollection(collectionRef, batchSize);
}
