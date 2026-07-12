importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAldFg5ofZgXfgn_JSORc_uqkWuq5sGnIY",
  authDomain: "padelos-6f999.firebaseapp.com",
  projectId: "padelos-6f999",
  storageBucket: "padelos-6f999.firebasestorage.app",
  messagingSenderId: "807847071392",
  appId: "1:807847071392:web:b104417c7af0f5967f43c5",
});

const messaging = firebase.messaging();

// Shows a system notification when a push arrives while the app is closed
// or in the background. Foreground pushes are handled inside the app itself.
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "Matchkeeper";
  const options = {
    body: payload.notification?.body || "",
    icon: "/logo-icon-192.png",
    badge: "/favicon-32.png",
  };
  self.registration.showNotification(title, options);
});
