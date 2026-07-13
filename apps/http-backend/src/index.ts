import express, { json, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { authenticator } from "./config";
import {
	requiredBodySignup,
	requiredBodySignin,
	createRoomSchema,
} from "@repo/fullstack-common/types";
import { db } from "@repo/db/prismaClient";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cors from "cors";
import helmet from "helmet";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import env from "dotenv";

env.config();

export const HTTP_URL = process.env.HTTP_URL;
export const WS_URL = process.env.WS_URL;
export const FE_URL = process.env.FE_URL;
export const JWT_SECRET = process.env.JWT_SECRET;
export const EXP_TIME = process.env.EXP_TIME;

const isProd = process.env.NODE_ENV === "production";

const cookieConfig = {
	httpOnly: true,
	secure: isProd, // secure only in prod (HTTPS)
	sameSite: "lax" as const,
	path: "/",
	maxAge: 1000 * 60 * 60 * 24 * 4,
	...(isProd && { domain: process.env.COOKIE_DOMAIN }), // only set domain in prod
};

const app = express();

app.use(helmet());
app.use(json());
app.use((req, res, next) => {
	console.log(req.url);
	next();
});
app.use(cookieParser());
app.use(
	cors({
		origin: [
			"https://Grafiq.com",
			"http://localhost:3000",
			process.env.FE_URL ? process.env.FE_URL : "",
		], // Your frontend URL
		credentials: true,
		methods: ["GET", "POST"],
		allowedHeaders: ["Content-Type", "Authorization"],
	}),
);

app.use(passport.initialize());

interface authRequest extends Request {
	user: {
		id: string;
		nfl: string;
	};
	cookies: {
		__uIt: string;
	};
}

function generateSecureString(length: number) {
	const array = new Uint8Array(length);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => byte.toString(36))
		.join("")
		.substring(0, length);
}

// 🔐 Auth Related Endpoints
// ------------------------------------------------------------------------------------------------------------------------------
// Sign-Up endpoint
app.post("/api/v1/auth/signup", async (req, res) => {
	// input validation by zod
	const result = requiredBodySignup.safeParse(req.body);
	if (!result.success) {
		const errors = result.error.issues[0]?.message;
		res.status(400).json({
			message: errors,
		});
		return;
	}

	// Main Logic
	try {
		// check if email exist??
		const isEmailExist = (
			await db.user.findUnique({
				where: {
					email: result.data.email,
				},
				select: {
					email: true,
				},
			})
		)?.email;

		if (isEmailExist) {
			res.status(400).json({ message: "User Already Exist! Go to Login!" });
			return;
		}

		//Hash passwords
		const hashedPassword = await bcrypt.hash(result.data.password, 10);

		// Enter into DB
		const userId = (
			await db.user.create({
				data: {
					email: result.data.email,
					name: result.data.username,
					password: hashedPassword,
				},
				select: {
					id: true,
				},
			})
		).id;

		// User registered successfully
		res.status(200).json({
			message: "Successful Registration!",
		});
	} catch (error) {
		console.log(error);
		res.status(500).json({ message: "Internal Server Error!" });
	}
});

// Sign-In endpoint
app.post("/api/v1/auth/signin", async (req, res) => {
	// Input Validation by zod
	const result = requiredBodySignin.safeParse(req.body);
	if (!result.success) {
		const errors = result.error.issues[0]?.message;
		res.status(400).json({ message: errors });
		return;
	}

	try {
		// Check for user exist or not
		const userData = await db.user.findUnique({
			where: {
				email: result.data.email,
			},
			select: {
				id: true,
				email: true,
				name: true,
				password: true,
			},
		});

		if (!userData?.email) {
			res
				.status(400)
				.json({ message: "User doesn't exist! Please Signup first!" });
			return;
		}

		//If password is valid
		const isPasswordValid = await bcrypt.compare(
			result.data.password,
			userData.password,
		);
		if (!isPasswordValid) {
			res.status(400).json({ message: "Incorrect Password!" });
			return;
		}

		//Generate Tokens
		const token = jwt.sign(
			{ userId: userData.id, nfl: userData.name[0] },
			JWT_SECRET!,
			{ expiresIn: EXP_TIME } as jwt.SignOptions,
		);
		res
			.status(200)
			.cookie("__uIt", token, cookieConfig)
			.json({ message: "Successful Login!", name: userData.name });
	} catch (error) {
		console.log(error);
		res.status(500).json({ message: "Internal Server Error!" });
	}
});

// 🔒 Google OAuth (sign-in / sign-up)
// ------------------------------------------------------------------------------------------------------------------------------
passport.use(
	new GoogleStrategy(
		{
			clientID: process.env.GOOGLE_CLIENT_ID!,
			clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
			callbackURL: `${HTTP_URL}/auth/google/return`,
			scope: ["profile", "email"],
		},
		async (_accessToken, _refreshToken, profile, done) => {
			try {
				const userEmail = profile.emails && profile.emails[0]?.value;
				if (!userEmail) {
					return done(new Error("No email found in Google profile"), undefined);
				}

				let user = await db.user.findUnique({
					where: { email: userEmail },
				});

				if (!user) {
					// First Google sign-in for this email: create the account
					user = await db.user.create({
						data: {
							email: userEmail,
							name: profile.displayName || "Google User",
							password: await bcrypt.hash(
								Math.random().toString(36).slice(-10),
								10,
							),
							googleId: profile.id,
							photo: profile.photos?.[0]?.value,
						},
					});
				} else if (!user.googleId) {
					// Existing email/password account: link the Google id
					user = await db.user.update({
						where: { id: user.id },
						data: { googleId: profile.id },
					});
				}

				return done(null, { id: user.id, email: user.email, nfl: user.name[0] });
			} catch (error) {
				return done(error as Error, undefined);
			}
		},
	),
);

// Step 1: send the user to Google's consent screen
app.get(
	"/api/v1/auth/google",
	passport.authenticate("google", { scope: ["profile", "email"] }),
);

// Step 2: Google redirects back here — mint our JWT cookie and bounce to the app
app.get(
	"/auth/google/return",
	(req, res, next) => {
		if (req.query.error) {
			return res.redirect(`${FE_URL}/signin`);
		}
		passport.authenticate("google", {
			session: false,
			failureRedirect: `${FE_URL}/signin`,
		})(req, res, next);
	},
	(req, res) => {
		try {
			const user = req.user as { id: string; email: string; nfl: string };
			const token = jwt.sign({ userId: user.id, nfl: user.nfl }, JWT_SECRET!, {
				expiresIn: EXP_TIME,
			} as jwt.SignOptions);
			res.cookie("__uIt", token, cookieConfig).redirect(`${FE_URL}/dashboard`);
		} catch (error) {
			res.redirect(`${FE_URL}/signin`);
		}
	},
);

// 📝 CRUD Related Endpoints
//----------------------------------------------------------------

// Create-Room endpoint
app.post(
	"/api/v1/user/room",
	authenticator,
	async (req: Request, res: Response) => {
		// Input Validation
		const authreq = req as authRequest;
		const result = createRoomSchema.safeParse(req.body);
		if (!result.success) {
			const errors = result.error.format();
			//console.log(`Error during input valdation:${errors}`);
			res.status(400).json({
				message: "Input Wrong Format!",
				error: errors,
			});
			return;
		}

		// Create Room
		try {
			const userId = authreq.user.id;
			// console.log(`user_Id : ${userId}`)
			const colors = ["blue", "green", "purple", "orange", "red", "teal"];
			const randomColor = colors[Math.floor(Math.random() * colors.length)];
			const userData = await db.room.create({
				data: {
					slug: result.data.name,
					adminId: userId,
					thumbnail: randomColor || "purple",
					sharedKey: generateSecureString(16),
				},
			});
			res.status(200).json({ roomId: userData.id, roomName: userData.slug });
		} catch (error) {
			console.log(error);
			res.status(500).json({ message: "Internal Server Error", err: error });
		}
	},
);

// Get room related chats by room Id
app.get("/api/v1/user/chats/:roomId", authenticator, async (req, res) => {
	const roomId = Number(req.params.roomId);
	try {
		const messages = await db.chat.findMany({
			where: {
				roomId: roomId,
			},
			orderBy: {
				createAt: "asc",
			},
			select: {
				id: true,
				message: true,
			},
			take: 2000,
		});

		res.status(200).json({ messages });
	} catch (error) {
		console.log(error);
		res.status(500).json({ message: "Internal Server Error!" });
	}
});

// Get all rooms of that particular user
app.get(
	"/api/v1/user/rooms/all",
	authenticator,
	async (req: Request, res: Response) => {
		const authreq = req as authRequest;
		const userId = authreq.user.id;
		const nfl = authreq.user.nfl;
		try {
			const rooms = await db.room.findMany({
				where: {
					adminId: userId,
				},
				select: {
					id: true,
					slug: true,
					createAt: true,
					thumbnail: true,
					sharedKey: true,
				},
			});
			// console.log(nfl);
			res.status(200).json({ rooms: rooms, nfl: nfl });
		} catch (error) {
			console.log("DB failure!");
			console.log(error);
			res.status(500).json({ message: "Internal Server Error!" });
		}
	},
);

// Check Authorization status
app.get("/api/v1/room/status/:roomId", authenticator, async (req, res) => {
	// console.log("Endpoint hit!");
	// console.log(req.query);
	try {
		// console.log("Inside Try!");
		const authreq = req as authRequest;
		const roomId = Number(req.params.roomId);
		const sharedKey = req.query.sharedKey;
		// console.log(sharedKey);
		if (sharedKey !== "null") {
			// console.log("HI!");
			const actualKey = await db.room.findUnique({
				where: {
					id: roomId,
				},
				select: {
					sharedKey: true,
				},
			});

			if (sharedKey === actualKey?.sharedKey) {
				res.status(200).json({ check: true });
				return;
			}
			res.status(403).json({ check: false });
		} else {
			// console.log("no shared key");
			const data = await db.room.findUnique({
				where: {
					id: roomId,
				},
			});
			// console.log(data);
			// console.log(authreq.user);
			if (data?.adminId === authreq.user.id) {
				// console.log('Done!');
				res.status(200).json({ check: true });
				return;
			}
			res.status(403).json({ check: false });
		}
	} catch (error) {
		// console.log("Inside catch!");
		res.status(403).json({ check: false });
	}
});

// ⏩ Logout endpoint
app.post("/api/v1/auth/signout", (req: Request, res: Response) => {
	try {
		res
			.status(200)
			.clearCookie("__uIt", cookieConfig)
			.json({ flag: true, message: "Logout Successfully" });
	} catch (error) {
		console.log(error);
		res.status(500).json({ flag: false, message: "Internal Server Error!" });
	}
});

app.listen(3001, () => {
	console.log(`Server is running at ${HTTP_URL}`);
});

// Scope of Improvements :-
//=======================
// - Room Permissions
// - Rate Limiting
// - Use Queues for performance
// - Use better DS for User object
