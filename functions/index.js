// functions/index.js
// v3 - Add reaction deduplication per user+utterance+type
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
admin.initializeApp();

exports.addReaction = onRequest(async (request, response) => {
  response.set('Access-Control-Allow-Origin', '*');
  if (request.method === 'OPTIONS') {
    response.set('Access-Control-Allow-Methods', 'POST');
    response.set('Access-Control-Allow-Headers', 'Content-Type');
    response.set('Access-control-max-age', '3600');
    response.status(204).send('');
    return;
  }
  if (request.method !== "POST") {
    response.status(405).send("Method Not Allowed");
    return;
  }

  const { session_id, utterance_guid, reaction_type, text, language, anonymous_id } = request.body;
  if (!session_id || !utterance_guid || !reaction_type) {
    response.status(400).send("Missing session_id, utterance_guid, or reaction_type.");
    return;
  }

  const db = getFirestore();

  try {
    const sessionDoc = db.collection('sessions').doc(session_id);
    const utteranceRef = sessionDoc.collection("utterances").doc(utterance_guid);
    const participantRef = sessionDoc.collection('participants').doc(anonymous_id || 'anonymous');

    // Dedup check: has this user already sent this reaction type for this utterance?
    // Use a deterministic doc ID: anonymous_id + utterance_guid + reaction_type
    const dedupeId = anonymous_id
      ? `${anonymous_id}_${utterance_guid}_${reaction_type.codePointAt(0)}`
      : null;
    const userReactionRef = dedupeId
      ? sessionDoc.collection('user_reactions').doc(dedupeId)
      : null;

    await db.runTransaction(async (transaction) => {
      const utteranceSnapshot = await transaction.get(utteranceRef);
      const participantSnapshot = anonymous_id ? await transaction.get(participantRef) : null;

      // Check for duplicate reaction
      if (userReactionRef) {
        const existingReaction = await transaction.get(userReactionRef);
        if (existingReaction.exists) {
          // Silently ignore — already counted
          return;
        }
      }

      // --- Utterance document ---
      if (!utteranceSnapshot.exists) {
        if (!text || !language) throw new Error("New utterance missing text/language.");
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

      // --- User reaction log (deterministic ID prevents duplicates) ---
      if (userReactionRef) {
        transaction.set(userReactionRef, {
          anonymous_id, utterance_guid, reaction_type,
          timestamp: FieldValue.serverTimestamp()
        });
      }

      // --- Participant counter + leaderboard ---
      if (anonymous_id && participantSnapshot) {
        if (!participantSnapshot.exists) {
          transaction.set(participantRef, { reaction_count: 1, anonymous_id });
          transaction.set(sessionDoc, { participant_count: FieldValue.increment(1) }, { merge: true });
        } else {
          transaction.update(participantRef, { reaction_count: FieldValue.increment(1) });
        }
      }
    });

    response.status(200).send("Reaction recorded.");
  } catch (error) {
    logger.error("Transaction failed:", error);
    response.status(500).send("Error writing to database.");
  }
});

exports.sendMessage = onCall({ cors: true }, async (request) => {
  const { sessionId, userId, message, persistent } = request.data;
  if (!sessionId || !userId || !message) {
    throw new HttpsError('invalid-argument', 'sessionId, userId, and message are required.');
  }
  const db = getFirestore();
  await db.collection('sessions').doc(sessionId)
    .collection('participants').doc(userId)
    .collection('messages').add({
      message,
      persistent: persistent === true,
      timestamp: FieldValue.serverTimestamp()
    });
  logger.info(`Message sent to ${userId} in session ${sessionId}`);
  return { status: 'success' };
});

exports.sendBroadcast = onCall({ cors: true }, async (request) => {
  const { sessionId, message, persistent } = request.data;
  if (!sessionId || !message) {
    throw new HttpsError('invalid-argument', 'sessionId and message are required.');
  }
  const db = getFirestore();
  const participantsSnap = await db.collection('sessions').doc(sessionId)
    .collection('participants').get();

  if (participantsSnap.empty) return { status: 'success', sent: 0 };

  const batch = db.batch();
  participantsSnap.docs.forEach(doc => {
    const msgRef = db.collection('sessions').doc(sessionId)
      .collection('participants').doc(doc.id)
      .collection('messages').doc();
    batch.set(msgRef, { message, persistent: persistent === true, timestamp: FieldValue.serverTimestamp() });
  });
  await batch.commit();

  logger.info(`Broadcast sent to ${participantsSnap.size} participants in session ${sessionId}`);
  return { status: 'success', sent: participantsSnap.size };
});

exports.resetSession = onCall({ cors: true }, async (request) => {
  const { sessionId } = request.data;
  if (!sessionId) {
    throw new HttpsError('invalid-argument', 'sessionId is required.');
  }
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
  if (snapshot.size === batchSize) {
    await deleteCollection(collectionRef, batchSize);
  }
}
