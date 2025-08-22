import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged, signOut, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, doc, setDoc, deleteDoc, query, where, addDoc } from 'firebase/firestore';

const App = () => {
    // State variables for Firebase
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAdmin, setIsAdmin] = useState(false);

    // App state
    const [movies, setMovies] = useState([]);
    const [submissions, setSubmissions] = useState([]);
    const [view, setView] = useState('list'); // 'list', 'submit', 'admin'
    const [isLoading, setIsLoading] = useState(true);
    const [message, setMessage] = useState(null);
    const [isGenerating, setIsGenerating] = useState({}); // To track which movie is generating a summary
    const [isReading, setIsReading] = useState({}); // To track which movie's description is being read

    // IMPORTANT: For a simple demonstration, a hardcoded admin list is used.
    // In a production application, you would manage admin roles in Firestore
    // and check the user's document for an 'isAdmin' flag.
    const ADMIN_USER_ID = "admin-user-id"; // Replace with your actual admin user ID after first login
    const ADMIN_EMAIL = "admin@example.com";
    const ADMIN_PASSWORD = "your-secure-password";

    // Firebase Initialization and Authentication
    useEffect(() => {
        const initFirebase = async () => {
            try {
                // IMPORTANT: These are global variables provided by the Canvas environment.
                const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
                const firebaseConfig = JSON.parse(typeof __firebase_config !== 'undefined' ? __firebase_config : '{}');

                if (!Object.keys(firebaseConfig).length) {
                    console.error('Firebase config is not available.');
                    setMessage({ type: 'error', text: 'Firebase configuration is missing.' });
                    setIsLoading(false);
                    return;
                }

                const app = initializeApp(firebaseConfig);
                const firestoreDb = getFirestore(app);
                const firestoreAuth = getAuth(app);

                // Use the provided custom auth token for authentication
                const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
                if (initialAuthToken) {
                    await signInWithCustomToken(firestoreAuth, initialAuthToken);
                } else {
                    await signInAnonymously(firestoreAuth);
                }

                // Listen for auth state changes to update the user ID and admin status
                onAuthStateChanged(firestoreAuth, (user) => {
                    if (user) {
                        setUserId(user.uid);
                        // Check if the authenticated user is the admin
                        setIsAdmin(user.uid === ADMIN_USER_ID);
                    } else {
                        setUserId(crypto.randomUUID());
                        setIsAdmin(false);
                    }
                    setDb(firestoreDb);
                    setAuth(firestoreAuth);
                    setIsLoading(false);
                });

            } catch (error) {
                console.error('Error initializing Firebase:', error);
                setMessage({ type: 'error', text: 'Failed to initialize the app.' });
                setIsLoading(false);
            }
        };

        initFirebase();
    }, []);

    // Firestore Real-time Data Listeners
    useEffect(() => {
        if (!db || !userId) {
            return;
        }

        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

        // Listen for real-time changes to the movies collection
        const movieCollectionRef = collection(db, `artifacts/${appId}/public/data/movies`);
        const unsubscribeMovies = onSnapshot(movieCollectionRef, (snapshot) => {
            const movieData = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            setMovies(movieData);
        }, (error) => {
            console.error("Error fetching movies:", error);
            setMessage({ type: 'error', text: 'Failed to load movie data.' });
        });

        // Listen for real-time changes to the submissions collection (admin view)
        const submissionCollectionRef = collection(db, `artifacts/${appId}/public/data/submissions`);
        const unsubscribeSubmissions = onSnapshot(submissionCollectionRef, (snapshot) => {
            const submissionData = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            setSubmissions(submissionData);
        }, (error) => {
            console.error("Error fetching submissions:", error);
            // This is a background task, no need to show error to user
        });

        // Clean up listeners on component unmount
        return () => {
            unsubscribeMovies();
            unsubscribeSubmissions();
        };

    }, [db, userId]);

    // UI State Management for a better user experience
    const showMessage = (type, text) => {
        setMessage({ type, text });
        setTimeout(() => setMessage(null), 3000);
    };

    // --- Gemini API Functionality ---
    const generateSummary = async (movieId, movieDescription) => {
        setIsGenerating(prev => ({ ...prev, [movieId]: true }));
        try {
            const prompt = `Write a very short, spooky, and enticing summary for a horror movie with the following description: ${movieDescription}. The summary should be 1-2 sentences.`;
            let retries = 0;
            const maxRetries = 5;
            let response;
            let result;

            while (retries < maxRetries) {
                try {
                    const payload = { contents: [{ parts: [{ text: prompt }] }] };
                    const apiKey = "";
                    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

                    response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });

                    if (response.status === 429) { // Too Many Requests
                        retries++;
                        const delay = Math.pow(2, retries) * 1000;
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }

                    result = await response.json();
                    break; // Success, break the loop
                } catch (error) {
                    console.error("Fetch attempt failed:", error);
                    retries++;
                    const delay = Math.pow(2, retries) * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }

            if (!response.ok || !result || !result.candidates || result.candidates.length === 0) {
                throw new Error('API response was not successful or content was missing.');
            }

            const summary = result.candidates[0].content.parts[0].text;
            setMovies(prevMovies => prevMovies.map(movie =>
                movie.id === movieId ? { ...movie, geminiSummary: summary } : movie
            ));
        } catch (error) {
            console.error("Error generating summary:", error);
            showMessage('error', 'Failed to generate summary.');
        } finally {
            setIsGenerating(prev => ({ ...prev, [movieId]: false }));
        }
    };

    const playDescription = async (movieId, description) => {
        setIsReading(prev => ({ ...prev, [movieId]: true }));
        try {
            const payload = {
                contents: [{ parts: [{ text: `Say in a spooky, narrative tone: ${description}` }] }],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: "Rasalgethi" } // Using a deep, informative voice
                        }
                    }
                },
                model: "gemini-2.5-flash-preview-tts"
            };
            const apiKey = "";
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            const part = result?.candidates?.[0]?.content?.parts?.[0];
            const audioData = part?.inlineData?.data;
            const mimeType = part?.inlineData?.mimeType;

            if (audioData && mimeType && mimeType.startsWith("audio/")) {
                const sampleRate = parseInt(mimeType.match(/rate=(\d+)/)[1], 10);
                const pcmData = base64ToArrayBuffer(audioData);
                const pcm16 = new Int16Array(pcmData);
                const wavBlob = pcmToWav(pcm16, sampleRate);
                const audioUrl = URL.createObjectURL(wavBlob);
                const audio = new Audio(audioUrl);
                audio.play();
                audio.onended = () => setIsReading(prev => ({ ...prev, [movieId]: false }));
            } else {
                throw new Error("Invalid audio data received.");
            }

        } catch (error) {
            console.error("Error playing audio:", error);
            showMessage('error', 'Failed to play audio.');
            setIsReading(prev => ({ ...prev, [movieId]: false }));
        }
    };

    // Helper function to convert base64 to ArrayBuffer
    const base64ToArrayBuffer = (base64) => {
        const binaryString = atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    };

    // Helper function to convert PCM data to WAV Blob
    const pcmToWav = (pcmData, sampleRate) => {
        const numChannels = 1;
        const bitsPerSample = 16;
        const byteRate = (bitsPerSample * sampleRate * numChannels) / 8;
        const blockAlign = (numChannels * bitsPerSample) / 8;

        const buffer = new ArrayBuffer(44 + pcmData.byteLength);
        const view = new DataView(buffer);

        // RIFF header
        writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + pcmData.byteLength, true);
        writeString(view, 8, 'WAVE');

        // fmt sub-chunk
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM format
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);

        // data sub-chunk
        writeString(view, 36, 'data');
        view.setUint32(40, pcmData.byteLength, true);

        // Write PCM data
        for (let i = 0; i < pcmData.length; i++) {
            view.setInt16(44 + i * 2, pcmData[i], true);
        }

        return new Blob([view], { type: 'audio/wav' });
    };

    const writeString = (view, offset, string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };

    // --- Component Logic for Submissions and Admin ---

    const handleAdminLogin = async (email, password) => {
        if (!auth) return;
        try {
            await signInWithEmailAndPassword(auth, email, password);
            showMessage('success', 'Admin login successful!');
            setView('admin'); // Navigate to admin panel after login
        } catch (error) {
            console.error("Error logging in:", error);
            showMessage('error', 'Admin login failed. Please check your credentials.');
        }
    };

    const handleAdminLogout = async () => {
        if (!auth) return;
        try {
            await signOut(auth);
            showMessage('success', 'Logged out successfully.');
            setView('list'); // Redirect to movie list after logout
        } catch (error) {
            console.error("Error logging out:", error);
            showMessage('error', 'Failed to log out.');
        }
    };

    const handleApproveSubmission = async (submission) => {
        if (!db) return;
        try {
            const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
            const movieRef = doc(collection(db, `artifacts/${appId}/public/data/movies`));
            const submissionRef = doc(db, `artifacts/${appId}/public/data/submissions`, submission.id);

            // Add the new movie to the public movies collection
            await setDoc(movieRef, {
                name: submission.name,
                description: submission.description,
                rating: submission.rating,
                imageUrl: submission.imageUrl || 'https://placehold.co/400x600/1a1a1a/ff6b6b?text=Movie+Image'
            });

            // Delete the submission from the submissions collection
            await deleteDoc(submissionRef);

            showMessage('success', `"${submission.name}" approved successfully!`);
        } catch (error) {
            console.error("Error approving submission:", error);
            showMessage('error', `Failed to approve "${submission.name}".`);
        }
    };

    const handleRejectSubmission = async (submissionId) => {
        if (!db) return;
        try {
            const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
            const submissionRef = doc(db, `artifacts/${appId}/public/data/submissions`, submissionId);
            await deleteDoc(submissionRef);
            showMessage('success', 'Submission rejected.');
        } catch (error) {
            console.error("Error rejecting submission:", error);
            showMessage('error', 'Failed to reject submission.');
        }
    };

    const handleSubmitNewMovie = async (movieData) => {
        if (!db) return;
        try {
            const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
            const submissionRef = collection(db, `artifacts/${appId}/public/data/submissions`);
            await addDoc(submissionRef, {
                ...movieData,
                submittedBy: userId,
                timestamp: new Date()
            });
            showMessage('success', 'Your movie has been submitted for review!');
            setView('list'); // Redirect to movie list after submission
        } catch (error) {
            console.error("Error submitting movie:", error);
            showMessage('error', 'Failed to submit movie.');
        }
    };

    // --- UI Components ---

    const Header = () => (
        <header className="bg-neutral-800 text-white p-4 shadow-lg rounded-b-xl flex justify-between items-center flex-wrap">
            <h1 className="text-3xl font-bold tracking-wide text-red-500 font-inter">Horror Movie Hub</h1>
            <nav className="flex space-x-4 mt-2 sm:mt-0">
                <button onClick={() => setView('list')} className="px-4 py-2 bg-red-600 hover:bg-red-700 transition-colors duration-200 rounded-lg shadow-md text-white font-semibold">Movies</button>
                <button onClick={() => setView('submit')} className="px-4 py-2 bg-neutral-600 hover:bg-neutral-700 transition-colors duration-200 rounded-lg shadow-md text-white font-semibold">Submit a Movie</button>
                {isAdmin ? (
                    <button onClick={() => setView('admin')} className="px-4 py-2 bg-red-600 hover:bg-red-700 transition-colors duration-200 rounded-lg shadow-md text-white font-semibold">Admin Panel</button>
                ) : (
                    <button onClick={() => setView('admin')} className="px-4 py-2 bg-neutral-600 hover:bg-neutral-700 transition-colors duration-200 rounded-lg shadow-md text-white font-semibold">Admin Login</button>
                )}
                {isAdmin && (
                    <button onClick={handleAdminLogout} className="px-4 py-2 bg-neutral-600 hover:bg-neutral-700 transition-colors duration-200 rounded-lg shadow-md text-white font-semibold">Logout</button>
                )}
            </nav>
        </header>
    );

    const MovieList = () => (
        <div className="container mx-auto p-4">
            <h2 className="text-2xl font-bold mb-6 text-center text-neutral-800">Featured Films</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                {movies.map(movie => (
                    <div key={movie.id} className="bg-neutral-900 text-white rounded-lg shadow-xl overflow-hidden transform hover:scale-105 transition-transform duration-300">
                        <img
                            src={movie.imageUrl}
                            alt={movie.name}
                            className="w-full h-72 object-cover"
                            onError={(e) => { e.target.onerror = null; e.target.src = "https://placehold.co/400x600/1a1a1a/ff6b6b?text=Movie+Image" }}
                        />
                        <div className="p-5">
                            <h3 className="text-xl font-bold text-red-500 mb-2">{movie.name}</h3>
                            <p className="text-sm text-neutral-400 mb-3">{movie.description}</p>
                            
                            {/* Gemini Spooky Summary */}
                            {movie.geminiSummary && (
                                <p className="text-sm font-semibold text-red-400 mb-3 border-l-2 border-red-500 pl-2 italic">
                                    "✨ {movie.geminiSummary}"
                                </p>
                            )}

                            <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center">
                                    <span className="text-yellow-400 mr-2">
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.381-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                                        </svg>
                                    </span>
                                    <span className="text-neutral-200 font-semibold">{movie.rating} / 5</span>
                                </div>
                                <div className="flex space-x-2">
                                    <button
                                        onClick={() => generateSummary(movie.id, movie.description)}
                                        disabled={isGenerating[movie.id]}
                                        className="text-red-500 text-sm font-semibold p-1 rounded-md transition-colors duration-200"
                                    >
                                        {isGenerating[movie.id] ? (
                                            <svg className="animate-spin h-5 w-5 text-red-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                            </svg>
                                        ) : (
                                            '✨'
                                        )}
                                    </button>
                                    <button
                                        onClick={() => playDescription(movie.id, movie.description)}
                                        disabled={isReading[movie.id]}
                                        className="text-white text-sm font-semibold p-1 rounded-md transition-colors duration-200"
                                    >
                                        {isReading[movie.id] ? (
                                            <svg className="animate-pulse h-5 w-5 text-red-500" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24">
                                                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 16H9V8h2v10zm4 0h-2V8h2v10z"/>
                                            </svg>
                                        ) : (
                                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-red-500" viewBox="0 0 20 20" fill="currentColor">
                                                <path fillRule="evenodd" d="M9.383 3.003h1.234c.162 0 .319.043.46.126.141.083.257.202.348.342l.666 1.011c.09.139.206.258.347.341.14.083.298.126.46.126h1.234c.162 0 .319-.043.46-.126.141-.083.257-.202.348-.342l.666-1.011c.09-.139.206-.258.347-.341.14-.083.298-.126.46-.126H17c.552 0 1 .448 1 1v12c0 .552-.448 1-1 1H3c-.552 0-1-.448-1-1V4c0-.552.448-1 1-1h1.234c.162 0 .319-.043.46-.126.141-.083.257-.202.348-.342l.666-1.011c.09-.139.206-.258.347-.341.14-.083.298-.126.46-.126H11.617c.162 0 .319.043.46.126.141.083.257.202.348.342l.666 1.011c.09.139.206.258.347.341.14.083.298.126.46.126h1.234c.162 0 .319-.043.46-.126.141-.083.257-.202.348-.342l.666-1.011c.09-.139.206-.258.347-.341.14-.083.298-.126.46-.126H17c.552 0 1 .448 1 1v12c0 .552-.448 1-1 1H3c-.552 0-1-.448-1-1V4c0-.552.448-1 1-1h6.383z" clipRule="evenodd" />
                                            </svg>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                ))}
                {movies.length === 0 && <p className="text-center text-neutral-500 col-span-full">No movies to display yet. Check back later!</p>}
            </div>
        </div>
    );

    const SubmissionForm = () => {
        const [form, setForm] = useState({ name: '', description: '', rating: '', imageUrl: '' });
        const [isSubmitting, setIsSubmitting] = useState(false);

        const handleChange = (e) => {
            const { name, value } = e.target;
            setForm(prev => ({ ...prev, [name]: value }));
        };

        const handleSubmit = (e) => {
            e.preventDefault();
            if (!form.name || !form.description || !form.rating) {
                showMessage('error', 'Please fill in all required fields.');
                return;
            }
            setIsSubmitting(true);
            handleSubmitNewMovie(form);
            setForm({ name: '', description: '', rating: '', imageUrl: '' });
            setIsSubmitting(false);
        };

        return (
            <div className="container mx-auto p-4 max-w-lg">
                <h2 className="text-2xl font-bold text-center mb-6 text-neutral-800">Submit a Movie for Review</h2>
                <form onSubmit={handleSubmit} className="bg-white p-8 rounded-xl shadow-lg border border-neutral-200">
                    <div className="mb-4">
                        <label htmlFor="name" className="block text-sm font-medium text-neutral-700">Movie Title</label>
                        <input type="text" id="name" name="name" value={form.name} onChange={handleChange} required className="mt-1 block w-full rounded-md border-neutral-300 shadow-sm focus:border-red-500 focus:ring-red-500 p-2 border"/>
                    </div>
                    <div className="mb-4">
                        <label htmlFor="description" className="block text-sm font-medium text-neutral-700">Description</label>
                        <textarea id="description" name="description" rows="3" value={form.description} onChange={handleChange} required className="mt-1 block w-full rounded-md border-neutral-300 shadow-sm focus:border-red-500 focus:ring-red-500 p-2 border"></textarea>
                    </div>
                    <div className="mb-4">
                        <label htmlFor="rating" className="block text-sm font-medium text-neutral-700">Your Rating (1-5)</label>
                        <input type="number" id="rating" name="rating" min="1" max="5" value={form.rating} onChange={handleChange} required className="mt-1 block w-full rounded-md border-neutral-300 shadow-sm focus:border-red-500 focus:ring-red-500 p-2 border"/>
                    </div>
                    <div className="mb-4">
                        <label htmlFor="imageUrl" className="block text-sm font-medium text-neutral-700">Image URL (Optional)</label>
                        <input type="url" id="imageUrl" name="imageUrl" value={form.imageUrl} onChange={handleChange} className="mt-1 block w-full rounded-md border-neutral-300 shadow-sm focus:border-red-500 focus:ring-red-500 p-2 border"/>
                    </div>
                    <button type="submit" disabled={isSubmitting} className="w-full bg-red-600 text-white font-semibold py-2 px-4 rounded-lg shadow-md hover:bg-red-700 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed">
                        {isSubmitting ? 'Submitting...' : 'Submit Movie'}
                    </button>
                </form>
            </div>
        );
    };

    const AdminLogin = () => {
        const [email, setEmail] = useState('');
        const [password, setPassword] = useState('');

        const handleLogin = (e) => {
            e.preventDefault();
            handleAdminLogin(email, password);
        };

        return (
            <div className="container mx-auto p-4 max-w-sm">
                <h2 className="text-2xl font-bold text-center mb-6 text-neutral-800">Admin Login</h2>
                <form onSubmit={handleLogin} className="bg-white p-8 rounded-xl shadow-lg border border-neutral-200">
                    <div className="mb-4">
                        <label htmlFor="email" className="block text-sm font-medium text-neutral-700">Email</label>
                        <input type="email" id="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="mt-1 block w-full rounded-md border-neutral-300 shadow-sm focus:border-red-500 focus:ring-red-500 p-2 border"/>
                    </div>
                    <div className="mb-4">
                        <label htmlFor="password" className="block text-sm font-medium text-neutral-700">Password</label>
                        <input type="password" id="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="mt-1 block w-full rounded-md border-neutral-300 shadow-sm focus:border-red-500 focus:ring-red-500 p-2 border"/>
                    </div>
                    <button type="submit" className="w-full bg-red-600 text-white font-semibold py-2 px-4 rounded-lg shadow-md hover:bg-red-700 transition-colors duration-200">
                        Login
                    </button>
                </form>
            </div>
        );
    };

    const AdminPanel = () => {
        if (!isAdmin) {
            return (
                <div className="container mx-auto p-4 text-center text-neutral-500">
                    <p className="text-lg font-semibold">You must be logged in as an admin to view this panel.</p>
                </div>
            );
        }
        
        return (
            <div className="container mx-auto p-4">
                <h2 className="text-2xl font-bold mb-6 text-center text-neutral-800">Admin Panel - Pending Submissions</h2>
                {submissions.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {submissions.map(submission => (
                            <div key={submission.id} className="bg-white p-6 rounded-xl shadow-lg border border-neutral-200">
                                <h3 className="text-xl font-bold text-red-500 mb-2">{submission.name}</h3>
                                <p className="text-sm text-neutral-600 mb-4">{submission.description}</p>
                                <p className="text-sm font-semibold text-neutral-700 mb-2">Rating: {submission.rating} / 5</p>
                                <p className="text-sm text-neutral-500 mb-4">Submitted by: <span className="font-mono text-xs">{submission.submittedBy}</span></p>
                                {submission.imageUrl && <img src={submission.imageUrl} alt={submission.name} className="w-full h-48 object-cover rounded-lg mb-4" />}
                                <div className="flex space-x-2">
                                    <button
                                        onClick={() => handleApproveSubmission(submission)}
                                        className="flex-1 bg-green-600 text-white font-semibold py-2 px-4 rounded-lg shadow-md hover:bg-green-700 transition-colors duration-200"
                                    >
                                        Approve
                                    </button>
                                    <button
                                        onClick={() => handleRejectSubmission(submission.id)}
                                        className="flex-1 bg-red-600 text-white font-semibold py-2 px-4 rounded-lg shadow-md hover:bg-red-700 transition-colors duration-200"
                                    >
                                        Reject
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-center text-neutral-500">No new submissions to review.</p>
                )}
            </div>
        );
    };

    // Main App Renderer
    const renderContent = () => {
        switch (view) {
            case 'list':
                return <MovieList />;
            case 'submit':
                return <SubmissionForm />;
            case 'admin':
                return isAdmin ? <AdminPanel /> : <AdminLogin />;
            default:
                return <MovieList />;
        }
    };

    return (
        <div className="bg-neutral-100 min-h-screen font-sans flex flex-col">
            <style>
                {`
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');
                .font-sans { font-family: 'Inter', sans-serif; }
                `}
            </style>
            <Header />

            {/* Custom Message Box */}
            {message && (
                <div className={`fixed top-4 right-4 z-50 p-4 rounded-lg shadow-lg text-white ${message.type === 'success' ? 'bg-green-500' : 'bg-red-500'}`}>
                    {message.text}
                </div>
            )}

            <main className="flex-grow pb-8">
                {isLoading ? (
                    <div className="flex justify-center items-center h-full pt-20">
                        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-500"></div>
                        <p className="ml-4 text-neutral-600">Loading...</p>
                    </div>
                ) : (
                    renderContent()
                )}
            </main>

            <footer className="bg-neutral-800 text-white text-center p-4 mt-auto rounded-t-xl">
                <p>&copy; 2024 Horror Movie Hub</p>
                <p className="text-xs mt-1 text-neutral-400">Your user ID for data management: <span className="font-mono">{userId}</span></p>
            </footer>
        </div>
    );
};

export default App;
