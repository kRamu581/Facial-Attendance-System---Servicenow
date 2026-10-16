api.controller = function($scope, $element, $timeout) {
  var c = this;

  // =========================================================
  // CONFIGURATION
  // =========================================================
  var FACE_API_MODEL_URL =
    "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights";
  var FACE_API_URL =
    "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js";
  var THREE_URL =
    "https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js";
  var MEDIAPIPE_URL =
    "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js";
  var MEDIAPIPE_ASSET_URL =
    "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/";

  var video = null;
  var overlay = null;
  var overlayContext = null;
  var threeCanvas = null;

  var stream = null;
  var faceMesh = null;
  var threeRenderer = null;
  var threeScene = null;
  var threeCamera = null;
  var facePoints = null;
  var faceGeometry = null;

  var animationFrame = null;
  var cameraRunning = false;
  var modelsLoaded = false;
  var faceApiLoading = false;
  var mediaPipeReady = false;
  var processingFrame = false;
  var destroyed = false;

  c.loading = false;
  c.cameraReady = false;
  c.faceDetected = false;
  c.statusMessage = "Click Start Camera to begin.";
  c.analysisMessage = "3D face analysis is waiting for the camera.";
  c.errorMessage = "";
  c.successMessage = "";
  c.name = c.name || "";
  c.email = c.email || "";
  c.consent = false;
  c.distance = null;

  // =========================================================
  // HELPERS
  // =========================================================

  function findElement(ids) {
    var i;
    var element;
    for (i = 0; i < ids.length; i++) {
      element = $element[0].querySelector("#" + ids[i]);
      if (!element) {
        element = document.getElementById(ids[i]);
      }
      if (element) {
        return element;
      }
    }
    return null;
  }

  function safeDigest() {
    if (!destroyed) {
      $scope.$applyAsync();
    }
  }

  function setStatus(message) {
    c.statusMessage = message;
    safeDigest();
  }

  function setError(message) {
    c.errorMessage = message;
    c.successMessage = "";
    c.statusMessage = message;
    safeDigest();
  }

  function setSuccess(message) {
    c.successMessage = message;
    c.errorMessage = "";
    c.statusMessage = message;
    safeDigest();
  }

  function loadScript(url, globalName) {
    return new Promise(function(resolve, reject) {
      if (window[globalName]) {
        resolve(window[globalName]);
        return;
      }

      var existing = document.querySelector(
        'script[data-face-auth-src="' + url + '"]'
      );

      if (existing) {
        if (existing.getAttribute("data-loaded") === "true") {
          if (window[globalName]) {
            resolve(window[globalName]);
          } else {
            reject(new Error(globalName + " did not load."));
          }
          return;
        }

        existing.addEventListener("load", function() {
          if (window[globalName]) {
            resolve(window[globalName]);
          } else {
            reject(new Error(globalName + " is unavailable."));
          }
        });
        existing.addEventListener("error", function() {
          reject(new Error("Unable to load " + globalName + "."));
        });
        return;
      }

      var script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.setAttribute("data-face-auth-src", url);

      script.onload = function() {
        script.setAttribute("data-loaded", "true");
        if (window[globalName]) {
          resolve(window[globalName]);
        } else {
          reject(new Error(globalName + " is unavailable after loading."));
        }
      };
      script.onerror = function() {
        reject(new Error("Failed to load library: " + url));
      };

      document.head.appendChild(script);
    });
  }

  // =========================================================
  // ELEMENTS
  // =========================================================

  function initializeElements() {
    video = findElement(["video", "webcam", "videoElement", "face-video"]);
    overlay = findElement(["overlay", "face-overlay"]);
    threeCanvas = findElement(["face-3d-canvas"]);

    if (overlay) {
      overlayContext = overlay.getContext("2d");
    }

    if (!video) {
      throw new Error(
        "Webcam video element not found. Add a video element with id='video'."
      );
    }
  }

  // =========================================================
  // FACE-API.JS
  // =========================================================

  function loadFaceApi() {
    if (modelsLoaded) {
      return Promise.resolve();
    }

    if (faceApiLoading) {
      return Promise.reject(new Error("Face recognition is already initializing."));
    }

    faceApiLoading = true;

    return loadScript(FACE_API_URL, "faceapi")
      .then(function() {
        var faceapi = window.faceapi;
        if (!faceapi) {
          throw new Error("face-api.js is not available.");
        }

        return Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(FACE_API_MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(FACE_API_MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(FACE_API_MODEL_URL)
        ]);
      })
      .then(function() {
        modelsLoaded = true;
        faceApiLoading = false;
      })
      .catch(function(error) {
        faceApiLoading = false;
        throw new Error(
          "Could not load face-api.js models. " + error.message
        );
      });
  }

  // =========================================================
  // THREE.JS 3D VIEW (optional)
  // =========================================================

  function initializeThree() {
    if (threeRenderer) {
      return;
    }

    if (!threeCanvas || !window.THREE) {
      c.analysisMessage = "3D visualization unavailable. Face recognition still works.";
      return;
    }

    try {
      var THREE = window.THREE;

      threeScene = new THREE.Scene();
      threeCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
      threeCamera.position.z = 4;

      threeRenderer = new THREE.WebGLRenderer({
        canvas: threeCanvas,
        alpha: true,
        antialias: true
      });
      threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      threeScene.add(new THREE.AmbientLight(0xffffff, 1));

      var pointMaterial = new THREE.PointsMaterial({
        color: 0x28a7ff,
        size: 0.025,
        transparent: true,
        opacity: 0.9
      });

      var positions = new Float32Array(468 * 3);

      faceGeometry = new THREE.BufferGeometry();
      faceGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

      facePoints = new THREE.Points(faceGeometry, pointMaterial);
      threeScene.add(facePoints);

      resizeThreeCanvas();
      threeRenderer.render(threeScene, threeCamera);

      c.analysisMessage = "3D face model initialized.";
    } catch (error) {
      threeRenderer = null;
      c.analysisMessage = "Unable to initialize 3D view: " + error.message;
    }
  }

  function resizeThreeCanvas() {
    if (!threeRenderer || !threeCanvas || !threeCamera) {
      return;
    }

    var width = threeCanvas.clientWidth || 320;
    var height = threeCanvas.clientHeight || 240;

    threeRenderer.setSize(width, height, false);
    threeCamera.aspect = width / height;
    threeCamera.updateProjectionMatrix();
    threeRenderer.render(threeScene, threeCamera);
  }

  function updateThreeLandmarks(landmarks) {
    if (!faceGeometry || !facePoints || !threeRenderer || !landmarks || !landmarks.length) {
      return;
    }

    var positions = faceGeometry.attributes.position.array;
    var count = Math.min(landmarks.length, 468);
    var i;
    var point;

    for (i = 0; i < count; i++) {
      point = landmarks[i];
      positions[i * 3] = (point.x - 0.5) * 3.0;
      positions[i * 3 + 1] = -(point.y - 0.5) * 3.0;
      positions[i * 3 + 2] = -(point.z || 0) * 3.0;
    }

    for (i = count; i < 468; i++) {
      positions[i * 3] = 0;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = 0;
    }

    faceGeometry.attributes.position.needsUpdate = true;
    faceGeometry.computeBoundingSphere();
    threeRenderer.render(threeScene, threeCamera);

    c.analysisMessage = "3D landmark analysis active: " + count + " landmarks.";
    safeDigest();
  }

  // =========================================================
  // MEDIAPIPE FACE MESH (optional)
  // =========================================================

  function initializeMediaPipe() {
    if (faceMesh) {
      return Promise.resolve();
    }

    return loadScript(MEDIAPIPE_URL, "FaceMesh")
      .then(function() {
        if (!window.FaceMesh) {
          throw new Error("MediaPipe FaceMesh is unavailable.");
        }

        faceMesh = new window.FaceMesh({
          locateFile: function(file) {
            return MEDIAPIPE_ASSET_URL + file;
          }
        });

        faceMesh.setOptions({
          maxNumFaces: 1,
          refineLandmarks: true,
          minDetectionConfidence: 0.6,
          minTrackingConfidence: 0.6
        });

        faceMesh.onResults(function(results) {
          if (destroyed) {
            return;
          }
          if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
            updateThreeLandmarks(results.multiFaceLandmarks[0]);
          }
        });

        mediaPipeReady = true;
      })
      .catch(function(error) {
        faceMesh = null;
        mediaPipeReady = false;
        c.analysisMessage = "MediaPipe 3D analysis unavailable: " + error.message;
      });
  }

  // =========================================================
  // CAMERA
  // =========================================================

  c.startCamera = function() {
    c.errorMessage = "";
    c.successMessage = "";

    if (cameraRunning) {
      setStatus("Camera is already running.");
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError("Camera access is unavailable. Use HTTPS and a supported browser.");
      return;
    }

    setStatus("Loading face recognition models...");

    Promise.all([
      loadFaceApi(),
      loadScript(THREE_URL, "THREE").catch(function() {
        return null;
      })
    ])
      .then(function() {
        initializeThree();
        return initializeMediaPipe();
      })
      .then(function() {
        return navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 640 },
            height: { ideal: 480 }
          },
          audio: false
        });
      })
      .then(function(cameraStream) {
        stream = cameraStream;
        video.srcObject = stream;
        return video.play();
      })
      .then(function() {
        cameraRunning = true;
        c.cameraReady = true;
        setStatus("Camera ready. Look at the camera.");
        resizeOverlay();
        startDetectionLoop();
      })
      .catch(function(error) {
        setError("Camera initialization failed: " + error.message);
        stopCamera();
      });
  };

  function resizeOverlay() {
    if (!video || !overlay) {
      return;
    }
    overlay.width = video.videoWidth || video.clientWidth || 640;
    overlay.height = video.videoHeight || video.clientHeight || 480;
  }

  function drawFaceBox(box, label, color) {
    if (!overlayContext || !overlay || !box) {
      return;
    }

    overlayContext.clearRect(0, 0, overlay.width, overlay.height);

    overlayContext.lineWidth = 3;
    overlayContext.strokeStyle = color || "#28a7ff";
    overlayContext.strokeRect(box.x, box.y, box.width, box.height);

    if (label) {
      var fontSize = Math.max(14, Math.round(overlay.width / 30));
      overlayContext.font = "bold " + fontSize + "px Arial";

      var textWidth = overlayContext.measureText(label).width;
      var labelY = Math.max(0, box.y - fontSize - 8);

      overlayContext.fillStyle = color || "#28a7ff";
      overlayContext.fillRect(box.x, labelY, textWidth + 12, fontSize + 8);
      overlayContext.fillStyle = "#ffffff";
      overlayContext.fillText(label, box.x + 6, labelY + fontSize);
    }
  }

  function clearFaceBox() {
    if (overlayContext && overlay) {
      overlayContext.clearRect(0, 0, overlay.width, overlay.height);
    }
  }

  // =========================================================
  // FACE DETECTION
  // =========================================================

  // Light and fast: face box only. Used for the live preview loop.
  function detectBox() {
    if (!modelsLoaded || !video || video.readyState < 2) {
      return Promise.resolve(null);
    }

    var faceapi = window.faceapi;

    return faceapi
      .detectSingleFace(
        video,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })
      )
      .then(function(result) {
        if (!result) {
          c.faceDetected = false;
          clearFaceBox();
          safeDigest();
          return null;
        }

        c.faceDetected = true;
        drawFaceBox(result.box, "Face", "#28a7ff");
        safeDigest();
        return result;
      });
  }

  // Full: box + landmarks + 128-value descriptor. Used for Register / Check In.
  function detectFull() {
    if (!modelsLoaded || !video || video.readyState < 2) {
      return Promise.resolve(null);
    }

    var faceapi = window.faceapi;

    return faceapi
      .detectSingleFace(
        video,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })
      )
      .withFaceLandmarks()
      .withFaceDescriptor()
      .then(function(result) {
        if (!result) {
          return null;
        }
        return {
          descriptor: Array.prototype.slice.call(result.descriptor),
          box: result.detection.box
        };
      });
  }

  function startDetectionLoop() {
    if (!cameraRunning || destroyed) {
      return;
    }

    function tick() {
      if (!cameraRunning || destroyed) {
        return;
      }

      // Skip the preview while Register / Check In is running.
      if (!processingFrame && !c.loading && video && video.readyState >= 2) {
        processingFrame = true;

        detectBox()
          .then(function(result) {
            if (result && mediaPipeReady && faceMesh) {
              return faceMesh.send({ image: video });
            }
          })
          .catch(function() {
            // Keep the preview running even if a frame fails.
          })
          .then(function() {
            processingFrame = false;
          });
      }

      animationFrame = window.requestAnimationFrame(tick);
    }

    animationFrame = window.requestAnimationFrame(tick);
  }

  // =========================================================
  // REGISTER
  // =========================================================

  c.register = function() {
    c.errorMessage = "";
    c.successMessage = "";

    if (!c.name || !c.name.trim() || !c.email || !c.email.trim()) {
      setError("Enter your name and email address.");
      return;
    }

    if (!c.consent) {
      setError("Please tick the consent box before registering your face.");
      return;
    }

    if (!cameraRunning) {
      setError("Start the camera first.");
      return;
    }

    c.loading = true;
    setStatus("Detecting face...");

    detectFull()
      .then(function(result) {
        if (!result) {
          throw new Error("No face detected. Look directly at the camera.");
        }

        drawFaceBox(result.box, c.name.trim(), "#1f3cff");

        return c.server.get({
          action: "register",
          name: c.name.trim(),
          email: c.email.trim().toLowerCase(),
          consent: true,
          descriptor: JSON.stringify(result.descriptor)
        });
      })
      .then(function(response) {
        var data = response && response.data;

        if (!data) {
          throw new Error("No response received from the server.");
        }

        if (data.success) {
          setSuccess(data.message || "Face registered successfully.");
        } else {
          throw new Error(data.message || "Face registration failed.");
        }
      })
      .catch(function(error) {
        setError(error.message || "Face registration failed.");
      })
      .then(function() {
        c.loading = false;
        safeDigest();
      });
  };

  // =========================================================
  // MARK ATTENDANCE (check in / check out)
  // =========================================================

  c.mark = function(type) {
    c.errorMessage = "";
    c.successMessage = "";

    if (!cameraRunning) {
      setError("Start the camera first.");
      return;
    }

    c.loading = true;
    setStatus("Recognizing face...");

    var detected = null;

    detectFull()
      .then(function(result) {
        if (!result) {
          throw new Error("No face detected. Look directly at the camera.");
        }

        detected = result;

        return c.server.get({
          action: "mark",
          type: type || "checkin",
          descriptor: JSON.stringify(result.descriptor)
        });
      })
      .then(function(response) {
        var data = response && response.data;

        if (!data) {
          throw new Error("No response received from the server.");
        }

        if (typeof data.distance !== "undefined") {
          c.distance = data.distance;
        }

        if (data.success) {
          drawFaceBox(detected.box, data.name || "Recognized", "#1e9e3a");

          var text = (data.name ? data.name + ": " : "") +
            (data.message || "Attendance marked successfully.");

          if (data.status) {
            text += " Status: " + data.status + ".";
          }
          if (data.time) {
            text += " " + data.time;
          }

          setSuccess(text);
        } else {
          drawFaceBox(detected.box, "Unknown", "#d93025");
          throw new Error(data.message || "Face verification failed.");
        }
      })
      .catch(function(error) {
        setError(error.message || "Unable to mark attendance.");
      })
      .then(function() {
        c.loading = false;
        safeDigest();
      });
  };

  // =========================================================
  // STOP / CLEANUP
  // =========================================================

  function stopCamera() {
    cameraRunning = false;
    c.cameraReady = false;
    c.faceDetected = false;

    if (animationFrame) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }

    if (stream) {
      stream.getTracks().forEach(function(track) {
        track.stop();
      });
      stream = null;
    }

    if (video) {
      video.srcObject = null;
    }

    clearFaceBox();
  }

  c.stopCamera = function() {
    stopCamera();
    setStatus("Camera stopped.");
  };

  // =========================================================
  // STARTUP
  // =========================================================

  try {
    initializeElements();
  } catch (error) {
    setError(error.message);
  }

  var resizeHandler = function() {
    resizeOverlay();
    resizeThreeCanvas();
  };

  window.addEventListener("resize", resizeHandler);

  $scope.$on("$destroy", function() {
    destroyed = true;
    stopCamera();

    window.removeEventListener("resize", resizeHandler);

    if (faceMesh && typeof faceMesh.close === "function") {
      faceMesh.close();
    }
    if (threeRenderer) {
      threeRenderer.dispose();
    }
    if (faceGeometry) {
      faceGeometry.dispose();
    }
  });
};
