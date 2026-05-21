// Import Firebase Functions modules.
const { onRequest, onCall } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");

// Import and initialize the Firebase Admin SDK.
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
admin.initializeApp();

// Define the "addReaction" HTTP function.
exports.addReaction = onRequest(async (request, response) => {
  // Set CORS headers
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

  // Read session_id from the request body
  const { session_id, utterance_guid, reaction_type, text, language, anonymous_id } = request.body;
  if (!session_id || !utterance_guid || !reaction_type) {
    response.status(400).send("Missing session_id, utterance_guid, or reaction_type in request.");
    return;
  }

  const db = getFirestore();

  try {
    await db.runTransaction(async (transaction) => {
      // All document references are now nested under the session_id
      const sessionCollection = db.collection('sessions').doc(session_id);

      const utteranceRef = sessionCollection.collection("utterances").doc(utterance_guid);
      const participantRef = sessionCollection.collection('participants').doc(anonymous_id || 'anonymous');
      
      const utteranceDoc = await transaction.get(utteranceRef);
      const participantDoc = anonymous_id ? await transaction.get(participantRef) : null;

      // Update the utterance document
      if (!utteranceDoc.exists) {
        if (!text || !language) throw new Error("Utterance document does not exist, and text/language were not provided.");
        const newDocData = {
          text: text, language: language,
          first_seen_at: FieldValue.serverTimestamp(), last_reacted_at: FieldValue.serverTimestamp(),
          reaction_thumbs_up: reaction_type === '👍' ? 1 : 0,
          reaction_heart: reaction_type === '❤️' ? 1 : 0,
          reaction_thinking: reaction_type === '🤔' ? 1 : 0,
        };
        transaction.set(utteranceRef, newDocData);
      } else {
        const updateData = { last_reacted_at: FieldValue.serverTimestamp() };
        if (reaction_type === '👍') updateData.reaction_thumbs_up = FieldValue.increment(1);
        if (reaction_type === '❤️') updateData.reaction_heart = FieldValue.increment(1);
        if (reaction_type === '🤔') updateData.reaction_thinking = FieldValue.increment(1);
        transaction.update(utteranceRef, updateData);
      }

      // Log the user's reaction
      if (anonymous_id) {
        const userReactionRef = sessionCollection.collection('user_reactions').doc();
        transaction.set(userReactionRef, {
          anonymous_id: anonymous_id, utterance_guid: utterance_guid,
          reaction_type: reaction_type, timestamp: FieldValue.serverTimestamp()
        });
      }

      // Update Participant Counter & Leaderboard
      if (anonymous_id && participantDoc) {
         const sessionSummaryRef = sessionCollection;
        if (!participantDoc.exists) {
          transaction.set(participantRef, { reaction_count: 1, anonymous_id: anonymous_id });
          transaction.set(sessionSummaryRef, { participant_count: FieldValue.increment(1) }, { merge: true });
        } else {
          transaction.update(participantRef, { reaction_count: FieldValue.increment(1) });
        }
      }
    });

    response.status(200).send("Reaction successfully recorded.");
  } catch (error) {
    logger.error("Transaction failed: ", error);
    response.status(500).send("Error writing to database.");
  }
});

// "sendMessage" is now session-aware
exports.sendMessage = onCall({ cors: true }, (request) => {
  const sessionId = request.data.sessionId;
  const userId = request.data.userId;
  const messageText = request.data.message;

  if (!sessionId || !userId || !messageText) {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with "sessionId", "userId", and "message" arguments.');
  }

  const db = getFirestore();
  const messagePath = `sessions/${sessionId}/participants/${userId}/messages`;

  return db.collection(messagePath).add({
    message: messageText,
    timestamp: FieldValue.serverTimestamp()
  }).then(() => {
    logger.info(`Message sent to ${userId} in session ${sessionId}`);
    return { status: 'success' };
  });
});

// --- NEW FUNCTION: resetSession ---
exports.resetSession = onCall({ cors: true }, async (request) => {
  const sessionId = request.data.sessionId;
  if (!sessionId) {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a "sessionId" argument.');
  }

  const db = getFirestore();
  const sessionRef = db.collection('sessions').doc(sessionId);

  logger.info(`Starting reset for session: ${sessionId}`);

  // Delete subcollections first
  await deleteCollection(db, sessionRef.collection('utterances'));
  await deleteCollection(db, sessionRef.collection('participants'));
  await deleteCollection(db, sessionRef.collection('user_reactions'));
  
  // Finally, delete the main session document itself
  await sessionRef.delete();

  logger.info(`Successfully reset session: ${sessionId}`);
  return { status: 'success', message: `Session ${sessionId} has been reset.` };
});

// Helper function to delete collections recursively
async function deleteCollection(db, collectionRef, batchSize = 100) {
  const query = collectionRef.limit(batchSize);

  return new Promise((resolve, reject) => {
    deleteQueryBatch(db, query, resolve).catch(reject);
  });
}

async function deleteQueryBatch(db, query, resolve) {
  const snapshot = await query.get();

  const batchSize = snapshot.size;
  if (batchSize === 0) {
    // When there are no documents left, we are done
    resolve();
    return;
  }

  // Delete documents in a batch
  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    // Recursively delete sub-collections of each document (for participants/messages)
    const subcollections = doc.ref.listCollections();
    subcollections.then(collections => {
        for (let collection of collections) {
            deleteCollection(db, collection);
        }
    });
    batch.delete(doc.ref);
  });
  await batch.commit();

  // Recurse on the next process tick, to avoid hitting stack limits
  process.nextTick(() => {
    deleteQueryBatch(db, query, resolve);
  });
}