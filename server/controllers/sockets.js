const geolib = require("geolib");
const User = require("../models/User");
const Ride = require("../models/Ride"); // Import Ride model
const jwt = require("jsonwebtoken");

const handleSocketConnection = (io) => {
  const onDutyCaptains = {};

  io.use(async (socket, next) => {
    const token = socket.handshake.headers.access_token;
    if (!token) {
      return next(new Error("Authentication invalid: No token provided"));
    }
    try {
      const payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
      const user = await User.findById(payload.id);
      if (!user) {
        return next(new Error("Authentication invalid: User not found"));
      }
      socket.user = { id: payload.id, role: user.role };
      next();
    } catch (error) {
      console.log("Socket Error", error);
      return next(
        new Error("Authentication invalid: Token verification failed")
      );
    }
  });

  io.on("connection", (socket) => {
    const user = socket.user;
    console.log("User Joined🔴: ", user);

    if (user.role === "captain") {
      socket.on("goOnDuty", (coords) => {
        onDutyCaptains[user.id] = { socketId: socket.id, coords };
        socket.join("onDuty");
        console.log(`Captain ${user.id} is now on duty.🫡`);

        updateNearbyCaptains();
      });

      socket.on("goOffDuty", () => {
        delete onDutyCaptains[user.id];
        socket.leave("onDuty");
        console.log(`Captain ${user.id} is now off duty.😪`);

        updateNearbyCaptains();
      });

      // Update captain's location
      socket.on("updateLocation", (coords) => {
        if (onDutyCaptains[user.id]) {
          onDutyCaptains[user.id].coords = coords;
          console.log(`Captain ${user.id} updated location.`);
          updateNearbyCaptains();

          // Notify subscribed users about captain's location update
          socket.to(`captain_${user.id}`).emit("captainLocationUpdate", {
            captainId: user.id,
            coords,
          });
        }
      });
    }

    if (user.role === "customer") {
      socket.on("subscribeToZone", (customerCoords) => {
        socket.user.coords = customerCoords;

        const nearbyCaptains = Object.values(onDutyCaptains)
          .filter((captain) =>
            geolib.isPointWithinRadius(captain.coords, customerCoords, 60000)
          )
          .map((captain) => ({
            id: captain.socketId,
            coords: captain.coords,
          }));

        socket.emit("nearbyCaptains", nearbyCaptains);
      });

      socket.on("searchCaptain", async (rideId) => {
        try {
          const ride = await Ride.findById(rideId).populate("customer captain");
          if (!ride) {
            socket.emit("error", { message: "Ride not found" });
            return;
          }

          const { latitude: pickupLat, longitude: pickupLon } = ride.pickup;

          const findNearbyCaptains = () => {
            return Object.values(onDutyCaptains)
              .map((captain) => ({
                ...captain,
                distance: geolib.getDistance(captain.coords, {
                  latitude: pickupLat,
                  longitude: pickupLon,
                }),
              }))
              .filter((captain) => captain.distance <= 60000) // 60 km radius
              .sort((a, b) => a.distance - b.distance);
          };

          const emitNearbyCaptains = () => {
            const nearbyCaptains = findNearbyCaptains();
            if (nearbyCaptains.length > 0) {
              socket.emit("nearbyCaptains", nearbyCaptains);
              nearbyCaptains.forEach((captain) => {
                socket.to(captain.socketId).emit("rideOffer", ride);
              });
            } else {
              console.log("No captains nearby, retrying...");
            }
            return nearbyCaptains;
          };

          const MAX_RETRIES = 20;
          let retries = 0;
          let rideAccepted = false;
          let canceled = false;

          const retrySearch = async () => {
            retries++;
            if (canceled) return;

            const captains = emitNearbyCaptains();
            if (captains.length > 0 || retries >= MAX_RETRIES) {
              clearInterval(retryInterval);

              if (!rideAccepted && retries >= MAX_RETRIES) {
                await Ride.findByIdAndDelete(rideId);
                socket.emit("error", {
                  message: "No captains found for your ride within 5 minutes.",
                });
              }
            }
          };

          const retryInterval = setInterval(retrySearch, 10000);

          socket.on("rideAccepted", async () => {
            rideAccepted = true;
            clearInterval(retryInterval);
          });

          socket.on("cancelRide", async () => {
            canceled = true;
            clearInterval(retryInterval);

            await Ride.findByIdAndDelete(rideId);
            socket.emit("rideCanceled", {
              message: "Your ride has been canceled",
            });

            if (ride.captain) {
              const captainSocket = getCaptainSocket(ride.captain._id);
              if (captainSocket) {
                captainSocket.emit("rideCanceled", {
                  message: `The ride with customer ${user.id} has been canceled.`,
                });
              } else {
                console.log(`Captain not found for ride ${rideId}`);
              }
            } else {
              console.log(`No captain associated with ride ${rideId}`);
            }

            console.log(`Customer ${user.id} canceled the ride ${rideId}`);
          });
        } catch (error) {
          console.error("Error searching for captain:", error);
          socket.emit("error", { message: "Error searching for captain" });
        }
      });
    }

    // Subscribe to captain's location updates
    socket.on("subscribeToCaptainLocation", (captainId) => {
      const captain = onDutyCaptains[captainId];
      console.log(onDutyCaptains, captain);
      if (captain) {
        socket.join(`captain_${captainId}`);
        socket.emit("captainLocationUpdate", {
          captainId,
          coords: captain.coords,
        });
        console.log(
          `User ${user.id} subscribed to Captain ${captainId}'s location.`
        );
      }
    });

    socket.on("subscribeRide", async (rideId) => {
      socket.join(`ride_${rideId}`);
      try {
        const rideData = await Ride.findById(rideId).populate(
          "customer captain"
        );
        socket.emit("rideData", rideData);
      } catch (error) {
        socket.error("Failed to receive data");
      }
    });

    socket.on("disconnect", () => {
      if (user.role === "captain") {
        delete onDutyCaptains[user.id];
      } else if (user.role === "customer") {
        console.log(`Customer ${user.id} disconnected.`);
      }
    });

    function updateNearbyCaptains() {
      io.sockets.sockets.forEach((socket) => {
        if (socket.user?.role === "customer") {
          const customerCoords = socket.user?.coords;
          if (customerCoords) {
            const nearbyCaptains = Object.values(onDutyCaptains)
              .filter((captain) =>
                geolib.isPointWithinRadius(
                  captain.coords,
                  customerCoords,
                  60000
                )
              )
              .map((captain) => ({
                id: captain.socketId,
                coords: captain.coords,
              }));
            console.log("nearbyCaptains", nearbyCaptains)
            socket.emit("nearbyCaptains", nearbyCaptains);
          }
        }
      });
    }

    function getCaptainSocket(captainId) {
      const captain = Object.values(onDutyCaptains).find(
        (captain) => captain.userId.toString() === captainId.toString()
      );
      return captain ? io.sockets.sockets.get(captain.socketId) : null;
    }
  });
};

module.exports = handleSocketConnection;
