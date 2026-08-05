// functions/index.js
// v4 - Add registerAttendee, attendee_count tracking, engagement metrics
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
admin.initializeApp();

// --- REGISTER ATTENDEE ---
// Called when attendee app connects to a session, before any reaction.
// Creates participant doc if not exists, increments attendee_count on session.
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
  const sessionRef = db.collection('sessions').doc(session_id);
  const participantRef = sessionRef.collection('participants').doc(anonymous_id);

  try {
    await db.runTransaction(async (transaction) => {
      const participantSnap = await transaction.get(participantRef);
      if (!participantSnap.exists) {
        // New attendee — create doc and increment attendee_count
        transaction.set(participantRef, {
          anonymous_id,
          reaction_count: 0,
          registered_at: FieldValue.serverTimestamp()
        });
        transaction.set(sessionRef, {
          attendee_count: FieldValue.increment(1)
        }, { merge: true });
      }
      // If already exists, do nothing — idempotent
    });
    response.status(200).send('Registered.');
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

  const { session_id, utterance_guid, reaction_type, text, language, anonymous_id } = request.body;
  if (!session_id || !utterance_guid || !reaction_type) {
    response.status(400).send('Missing session_id, utterance_guid, or reaction_type.');
    return;
  }

  const db = getFirestore();

  try {
    const sessionRef = db.collection('sessions').doc(session_id);
    const utteranceRef = sessionRef.collection('utterances').doc(utterance_guid);
    const participantRef = sessionRef.collection('participants').doc(anonymous_id || 'anonymous');

    // Deterministic dedup ID prevents duplicate reactions
    const dedupeId = anonymous_id
      ? `${anonymous_id}_${utterance_guid}_${reaction_type.codePointAt(0)}`
      : null;
    const userReactionRef = dedupeId
      ? sessionRef.collection('user_reactions').doc(dedupeId)
      : null;

    // Map emoji to Firestore field — named keys for default 5, codepoint key for custom
    function emojiToField(emoji) {
      const named = { '👍':'reaction_thumbs_up','👎':'reaction_thumbs_down','❤️':'reaction_heart','🤔':'reaction_thinking','❓':'reaction_question' };
      return named[emoji] || `reaction_${emoji.codePointAt(0)}`;
    }
    const reactionField = emojiToField(reaction_type);

    await db.runTransaction(async (transaction) => {
      const utteranceSnap = await transaction.get(utteranceRef);
      const participantSnap = anonymous_id ? await transaction.get(participantRef) : null;

      // Dedup check
      if (userReactionRef) {
        const existingReaction = await transaction.get(userReactionRef);
        if (existingReaction.exists) return;
      }

      // Utterance document
      if (!utteranceSnap.exists) {
        if (!text || !language) throw new Error('New utterance missing text/language.');
        const initData = {
          text, language,
          first_seen_at: FieldValue.serverTimestamp(),
          last_reacted_at: FieldValue.serverTimestamp(),
          [reactionField]: 1,
        };
        transaction.set(utteranceRef, initData);
      } else {
        const updateData = {
          last_reacted_at: FieldValue.serverTimestamp(),
          [reactionField]: FieldValue.increment(1)
        };
        transaction.update(utteranceRef, updateData);
      }

      // User reaction log
      if (userReactionRef) {
        transaction.set(userReactionRef, {
          anonymous_id, utterance_guid, reaction_type,
          timestamp: FieldValue.serverTimestamp()
        });
      }

      // Participant — increment reaction_count
      // participant_count only increments on FIRST reaction (not on registration)
      if (anonymous_id && participantSnap) {
        if (!participantSnap.exists) {
          // Reacted before registering (edge case) — create doc
          transaction.set(participantRef, {
            anonymous_id,
            reaction_count: 1,
            registered_at: FieldValue.serverTimestamp()
          });
          // Increment both counts since they weren't registered
          transaction.set(sessionRef, {
            attendee_count: FieldValue.increment(1),
            participant_count: FieldValue.increment(1)
          }, { merge: true });
        } else {
          const wasReactor = (participantSnap.data().reaction_count || 0) > 0;
          transaction.update(participantRef, {
            reaction_count: FieldValue.increment(1)
          });
          // Only increment participant_count (reactors) on their FIRST reaction
          if (!wasReactor) {
            transaction.set(sessionRef, {
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
  const { sessionId, userId, message, persistent, link } = request.data;
  if (!sessionId || !userId || !message) {
    throw new HttpsError('invalid-argument', 'sessionId, userId, and message are required.');
  }
  const db = getFirestore();
  const msgData = {
    message,
    persistent: persistent === true,
    timestamp: FieldValue.serverTimestamp()
  };
  if (link) msgData.link = link;
  await db.collection('sessions').doc(sessionId)
    .collection('participants').doc(userId)
    .collection('messages').add(msgData);
  logger.info(`Message sent to ${userId} in session ${sessionId}`);
  return { status: 'success' };
});

// --- SEND BROADCAST ---
// engagedOnly: true = only reactors (reaction_count > 0), false = all registered attendees
exports.sendBroadcast = onCall({ cors: true }, async (request) => {
  const { sessionId, message, persistent, engagedOnly, link } = request.data;
  if (!sessionId || !message) {
    throw new HttpsError('invalid-argument', 'sessionId and message are required.');
  }
  const db = getFirestore();
  let participantsSnap = await db.collection('sessions').doc(sessionId)
    .collection('participants').get();

  if (participantsSnap.empty) return { status: 'success', sent: 0 };

  const docs = engagedOnly
    ? participantsSnap.docs.filter(d => (d.data().reaction_count || 0) > 0)
    : participantsSnap.docs;

  if (docs.length === 0) return { status: 'success', sent: 0 };

  const msgData = {
    message,
    persistent: persistent === true,
    timestamp: FieldValue.serverTimestamp()
  };
  if (link) msgData.link = link;

  const batch = db.batch();
  docs.forEach(doc => {
    const msgRef = db.collection('sessions').doc(sessionId)
      .collection('participants').doc(doc.id)
      .collection('messages').doc();
    batch.set(msgRef, msgData);
  });
  await batch.commit();

  logger.info(`Broadcast sent to ${docs.length} participants (engagedOnly=${engagedOnly}) in session ${sessionId}`);
  return { status: 'success', sent: docs.length };
});

// --- RESET SESSION ---
exports.resetSession = onCall({ cors: true }, async (request) => {
  const { sessionId } = request.data;
  if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId is required.');

  const db = getFirestore();
  const sessionRef = db.collection('sessions').doc(sessionId);

  await deleteCollection(sessionRef.collection('utterances'));
  await deleteCollection(sessionRef.collection('user_reactions'));

  const participantsSnap = await sessionRef.collection('participants').get();
  for (const pDoc of participantsSnap.docs) {
    await deleteCollection(pDoc.ref.collection('messages'));
    await pDoc.ref.delete();
  }
  await sessionRef.delete();

  logger.info(`Reset session: ${sessionId}`);
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

// --- NEW EVENT ---
// Archives current flat session data into sessions/{sid}/events/{eventId}/
// then resets the flat session for a fresh start.
exports.newEvent = onCall({ cors: true }, async (request) => {
  const { sessionId, eventName } = request.data;
  if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId is required.');

  const db = getFirestore();
  const sessionRef = db.collection('sessions').doc(sessionId);

  // Generate event ID from timestamp
  const eventId = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  const name = (eventName && eventName.trim()) ? eventName.trim()
    : `Event ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;

  const eventRef = sessionRef.collection('events').doc(eventId);

  // Read current flat session data
  const sessionSnap = await sessionRef.get();
  const sessionData = sessionSnap.exists ? sessionSnap.data() : {};

  // Copy utterances to archive
  const utterancesSnap = await sessionRef.collection('utterances').get();
  const participantsSnap = await sessionRef.collection('participants').get();
  const userReactionsSnap = await sessionRef.collection('user_reactions').get();

  const batchWrite = db.batch();

  // Create event archive doc
  batchWrite.set(eventRef, {
    event_id: eventId,
    name,
    created_at: FieldValue.serverTimestamp(),
    attendee_count: sessionData.attendee_count || 0,
    participant_count: sessionData.participant_count || 0,
    show_reactions: false,
  });

  // Copy utterances
  utterancesSnap.docs.forEach(d => {
    batchWrite.set(eventRef.collection('utterances').doc(d.id), d.data());
  });

  // Copy participants (without messages subcollection — too complex for batch)
  participantsSnap.docs.forEach(d => {
    batchWrite.set(eventRef.collection('participants').doc(d.id), d.data());
  });

  // Copy user_reactions
  userReactionsSnap.docs.forEach(d => {
    batchWrite.set(eventRef.collection('user_reactions').doc(d.id), d.data());
  });

  await batchWrite.commit();

  // Reset flat session data
  await deleteCollection(sessionRef.collection('utterances'));
  await deleteCollection(sessionRef.collection('user_reactions'));
  const pSnap = await sessionRef.collection('participants').get();
  for (const pDoc of pSnap.docs) {
    await deleteCollection(pDoc.ref.collection('messages'));
    await pDoc.ref.delete();
  }
  await sessionRef.set({
    participant_count: 0,
    attendee_count: 0,
    show_reactions: false,
  }, { merge: false });

  logger.info(`New event created: ${eventId} (${name}) for session ${sessionId}`);
  return { status: 'success', event_id: eventId, event_name: name };
});