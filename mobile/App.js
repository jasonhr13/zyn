import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import protocol from './src/protocol';

const {
  desktopOnlineFrom,
  mergeProxyGroups,
  parsePairingInput,
  selectedProxyLines,
  websocketUrl,
} = protocol;
import { addHarvesterListener, getMaxWindows, isHarvesterAvailable, startHarvester, stopHarvester } from './src/harvester';
import { loadPersistedState, savePersistedState } from './src/persist';

let cachedDeviceId = '';
function deviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  const stored = loadPersistedState();
  if (stored && stored.deviceId) {
    cachedDeviceId = String(stored.deviceId);
    return cachedDeviceId;
  }
  cachedDeviceId = `${Platform.OS}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return cachedDeviceId;
}

function PairingScanner({ onClose, onUrl }) {
  const [permission, requestPermission] = useCameraPermissions();
  const locked = useRef(false);
  const [hint, setHint] = useState('Point at the QR in Zyn Settings.');

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  if (!permission) {
    return (
      <SafeAreaView style={styles.root}>
        <Text style={styles.muted}>Checking camera…</Text>
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.body}>
          <Text style={styles.title}>Scan pairing QR</Text>
          <Text style={styles.muted}>Camera permission is required to scan the pairing QR from Settings.</Text>
          <TouchableOpacity style={styles.primary} onPress={requestPermission}>
            <Text style={styles.primaryText}>Allow camera</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondary} onPress={onClose}>
            <Text style={styles.secondaryText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.scanner}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (locked.current) return;
          const parsed = parsePairingInput(data);
          if (!parsed) {
            setHint('Not a Zyn pairing QR. Use the code from Settings.');
            return;
          }
          locked.current = true;
          onUrl(String(data || '').trim());
        }}
      />
      <SafeAreaView style={styles.scannerOverlay} pointerEvents="box-none">
        <Text style={styles.scannerHint}>{hint}</Text>
        <TouchableOpacity style={styles.secondary} onPress={onClose}>
          <Text style={styles.secondaryText}>Cancel</Text>
        </TouchableOpacity>
      </SafeAreaView>
    </View>
  );
}

function harvestStatusFromLog(text) {
  const line = String(text || '');
  if (/No proxies supplied/i.test(line)) return 'No proxies';
  if (/WebView too old|run failed/i.test(line)) return 'Failed to start';
  if (/^\s*Idle\s*$/i.test(line)) return 'Idle';
  if (/cdp attached|Fetch interception|local auth proxy|Harvesting —/i.test(line)) return 'Starting…';
  if (/No ATC button/i.test(line)) return 'No ATC button';
  if (/No Shape headers/i.test(line)) return 'No Shape headers';
  if (/ATC tap blocked/i.test(line)) return 'ATC blocked';
  if (/No cart POST/i.test(line)) return 'No cart POST';
  if (/Loading Product|Harvesting Cookie|Harvested Cookie|captured |ATC tap/i.test(line)) return 'Harvesting';
  return null;
}

function Segment({ label, selected }) {
  return (
    <View style={[styles.segment, selected && styles.segmentOn]}>
      <Text style={[styles.segmentText, selected && styles.segmentTextOn]}>{label}</Text>
    </View>
  );
}

export default function App() {
  const socketRef = useRef(null);
  const connectRef = useRef(() => {});
  const generationRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const lastPairRef = useRef('');
  const pingTimerRef = useRef(null);
  const pendingStartRef = useRef(null);
  const [pairingText, setPairingText] = useState('');
  const [scanning, setScanning] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [status, setStatus] = useState('Idle');
  const [paired, setPaired] = useState(false);
  const [sessionSaved, setSessionSaved] = useState(0);
  const [proxyGroups, setProxyGroups] = useState([]);
  const [selectedList, setSelectedList] = useState('');
  const [lowData, setLowData] = useState(false);
  const [workers, setWorkers] = useState(1);
  const [running, setRunning] = useState(false);
  const available = useMemo(() => isHarvesterAvailable(), []);
  const maxWindows = useMemo(() => getMaxWindows(), []);
  const selectedListRef = useRef(selectedList);
  const proxyGroupsRef = useRef(proxyGroups);
  const lowDataRef = useRef(lowData);
  const workersRef = useRef(workers);
  const runningRef = useRef(running);
  selectedListRef.current = selectedList;
  proxyGroupsRef.current = proxyGroups;
  lowDataRef.current = lowData;
  workersRef.current = workers;
  runningRef.current = running;

  const pendingCapturesRef = useRef([]);
  const send = (payload) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === 1) {
      try {
        socket.send(JSON.stringify(payload));
        return true;
      } catch {
        return false;
      }
    }
    if (payload && payload.type === 'capture') {
      const queue = pendingCapturesRef.current;
      queue.push(payload);
      if (queue.length > 40) queue.shift();
    }
    return false;
  };
  const flushCaptures = () => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== 1) return;
    const queue = pendingCapturesRef.current;
    while (queue.length) {
      try { socket.send(JSON.stringify(queue.shift())); } catch { break; }
    }
  };

  const clearPing = () => {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  };

  const connect = (rawText, { reconnect = false } = {}) => {
    const parsed = parsePairingInput(rawText != null ? rawText : pairingText);
    if (!parsed) {
      setStatus('That is not a Zyn pairing URL.');
      return;
    }
    lastPairRef.current = rawText != null ? String(rawText).trim() : pairingText;
    savePersistedState({
      pairingUrl: lastPairRef.current,
      deviceId: deviceId(),
      selectedList: selectedListRef.current,
      workers: workersRef.current,
      lowData: lowDataRef.current,
    });
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const generation = ++generationRef.current;
    const previous = socketRef.current;
    socketRef.current = null;
    try { previous && previous.close(); } catch {}
    const url = websocketUrl({ ...parsed, deviceId: deviceId() });
    const socket = new WebSocket(url);
    socketRef.current = socket;
    socket.onopen = () => {
      if (generation !== generationRef.current) return;
      setStatus('Waiting for Zyn…');
      try { socket.send(JSON.stringify({ type: 'hello', role: 'phone' })); } catch {}
      clearPing();
      pingTimerRef.current = setInterval(() => {
        if (socket.readyState === 1) {
          try { socket.send(JSON.stringify({ type: 'hello', role: 'phone' })); } catch {}
        }
      }, 20000);
    };
    socket.onclose = () => {
      if (generation !== generationRef.current) return;
      clearPing();
      setRunning(false);
      setPaired(false);
      stopHarvester();
      setStatus('Reconnecting…');
      reconnectTimerRef.current = setTimeout(() => {
        if (generation !== generationRef.current) return;
        connect(lastPairRef.current, { reconnect: true });
      }, reconnect ? 3000 : 800);
    };
    socket.onerror = () => {
      if (generation !== generationRef.current) return;
      setStatus('WebSocket error.');
    };
    socket.onmessage = (event) => {
      if (generation !== generationRef.current) return;
      let message;
      try { message = JSON.parse(String(event.data || '')); } catch { return; }
      if (message.type === 'registered' || message.type === 'peer-state') {
        const online = desktopOnlineFrom(message) === true;
        setPaired(online);
        if (!runningRef.current) setStatus(online ? 'Idle' : 'Waiting for Zyn…');
        if (online) {
          flushCaptures();
          const selected = selectedListRef.current;
          try {
            socket.send(JSON.stringify(selected
              ? { type: 'need-proxies', names: [selected] }
              : { type: 'need-proxies' }));
          } catch {}
        }
      }
      if (message.type === 'proxies') {
        const groups = mergeProxyGroups(proxyGroupsRef.current, message);
        setProxyGroups(groups);
        setSelectedList((current) => {
          const preferred = current || selectedListRef.current;
          if (groups.some((group) => group.name === preferred)) {
            selectedListRef.current = preferred;
            return preferred;
          }
          return current;
        });
        if (pendingStartRef.current && selectedProxyLines(groups, selectedListRef.current ? [selectedListRef.current] : []).length) {
          const pending = pendingStartRef.current;
          pendingStartRef.current = null;
          beginHarvest(pending.site, pending.lowData);
        }
      }
      if (message.type === 'start') {
        beginHarvest(message.site || 'target', message.lowData === true);
      }
      if (message.type === 'stop') {
        stopHarvester();
        setRunning(false);
        setStatus('Idle');
      }
      if (message.type === 'capture-ack') {
        if (message.ok) setSessionSaved((count) => count + (Number(message.saved) || 1));
        else setStatus('Zyn rejected capture');
      }
    };
  };
  connectRef.current = connect;

  useEffect(() => {
    if (!lastPairRef.current && !pairingText) return;
    savePersistedState({
      pairingUrl: lastPairRef.current || pairingText,
      deviceId: deviceId(),
      selectedList,
      workers,
      lowData,
    });
  }, [pairingText, selectedList, workers, lowData]);

  useEffect(() => {
    const captures = addHarvesterListener('onSensors', (event) => {
      const payload = event && typeof event === 'object' ? event : {};
      let headers = payload.headers && typeof payload.headers === 'object' ? payload.headers : {};
      if (typeof payload.headersJson === 'string' && payload.headersJson) {
        try { headers = JSON.parse(payload.headersJson) || headers; } catch {}
      }
      const sent = send({
        type: 'capture',
        cookieType: 'atc',
        headers,
        proxy: payload.proxy,
        userAgent: payload.userAgent,
        pageUrl: payload.pageUrl,
        deviceId: deviceId(),
      });
      if (!sent) setStatus('Not reaching Zyn');
    });
    const logs = addHarvesterListener('onLog', (event) => {
      if (!runningRef.current) return;
      const next = harvestStatusFromLog(event && event.text);
      if (next) setStatus(next);
    });
    const harvested = addHarvesterListener('onHarvested', () => {});
    const applyUrl = (url) => {
      const text = String(url || '').trim();
      if (!parsePairingInput(text)) return;
      const socket = socketRef.current;
      if (lastPairRef.current === text && socket && socket.readyState === 1) return;
      setPairingText(text);
      setScanning(false);
      connectRef.current(text);
    };
    const stored = loadPersistedState() || {};
    if (stored.selectedList) {
      selectedListRef.current = String(stored.selectedList);
      setSelectedList(String(stored.selectedList));
    }
    if (Number(stored.workers) > 0) setWorkers(Math.max(1, Math.min(maxWindows, Number(stored.workers) || 1)));
    if (stored.lowData === true) setLowData(true);
    if (stored.pairingUrl && parsePairingInput(stored.pairingUrl)) {
      setPairingText(String(stored.pairingUrl));
      connectRef.current(String(stored.pairingUrl));
    }
    Linking.getInitialURL().then(applyUrl).catch(() => {});
    const linking = Linking.addEventListener('url', (event) => applyUrl(event && event.url));
    return () => {
      captures.remove();
      logs.remove();
      harvested.remove();
      linking.remove();
      stopHarvester();
      generationRef.current += 1;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      try { socketRef.current && socketRef.current.close(); } catch {}
    };
  }, []);

  const beginHarvest = (site = 'target', requestedLowData) => {
    if (runningRef.current) return;
    if (!available) {
      setStatus('Harvester is not available on this device.');
      return;
    }
    const socket = socketRef.current;
    if (!socket || socket.readyState !== 1) {
      setStatus('Waiting for Zyn…');
      return;
    }
    const selected = selectedListRef.current;
    if (!selected) {
      setStatus('Select a proxy list first.');
      return;
    }
    const useLowData = requestedLowData === true || (requestedLowData !== false && lowDataRef.current === true);
    const lines = selectedProxyLines(proxyGroupsRef.current, [selected]);
    if (!lines.length) {
      pendingStartRef.current = { site, lowData: useLowData };
      send({ type: 'need-proxies', names: [selected] });
      setStatus('Starting…');
      return;
    }
    startHarvester({ proxies: lines, site, lowData: useLowData, workers: workersRef.current });
    setRunning(true);
    setStatus('Starting…');
  };

  const toggle = () => {
    if (running) {
      stopHarvester();
      setRunning(false);
      setStatus('Idle');
      return;
    }
    beginHarvest('target', lowData);
  };

  const listLabel = selectedList || 'Select a proxy list';
  const pairedOnce = Boolean(lastPairRef.current || pairingText);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      {scanning ? (
        <PairingScanner
          onClose={() => setScanning(false)}
          onUrl={(url) => {
            setScanning(false);
            setPairingText(url);
            connectRef.current(url);
          }}
        />
      ) : (
        <SafeAreaView style={styles.root}>
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <View style={styles.header}>
              <View style={styles.headerCopy}>
                <Text style={styles.title}>Harvester</Text>
                <Text style={styles.subtitle}>
                  {proxyGroups.length
                    ? `${proxyGroups.length} proxy list${proxyGroups.length === 1 ? '' : 's'} available`
                    : paired ? 'Waiting for proxy lists from Zyn' : 'Pair with Zyn desktop'}
                </Text>
              </View>
              <View style={styles.headerActions}>
                <View style={styles.iconChip}>
                  <Text style={styles.iconChipValue}>{sessionSaved}</Text>
                </View>
                <TouchableOpacity style={styles.iconBtn} onPress={() => setScanning(true)}>
                  <Text style={styles.iconBtnText}>QR</Text>
                </TouchableOpacity>
              </View>
            </View>

            {!pairedOnce ? (
              <View style={styles.welcome}>
                <Text style={styles.welcomeKicker}>Welcome to</Text>
                <Text style={styles.welcomeTitle}>Zyn</Text>
                <Text style={styles.muted}>Scan the pairing QR from Settings once. This phone reconnects by itself whenever Zyn is open.</Text>
                <TouchableOpacity style={styles.primary} onPress={() => setScanning(true)}>
                  <Text style={styles.primaryText}>Scan QR</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text style={styles.label}>Site</Text>
                <View style={styles.segmentRow}>
                  <Segment label="Target" selected />
                </View>

                <Text style={styles.label}>Proxy List</Text>
                {proxyGroups.length ? (
                  <View>
                    <Pressable style={styles.dropdown} onPress={() => setPickerOpen((open) => !open)}>
                      <Text style={selectedList ? styles.dropdownValue : styles.dropdownPlaceholder}>{listLabel}</Text>
                      <Text style={styles.chevron}>{pickerOpen ? '▴' : '▾'}</Text>
                    </Pressable>
                    {pickerOpen && proxyGroups.map((group) => (
                      <Pressable
                        key={group.name}
                        style={[styles.dropdownItem, selectedList === group.name && styles.dropdownItemOn]}
                        onPress={() => {
                          setSelectedList(group.name);
                          setPickerOpen(false);
                        }}
                      >
                        <Text style={styles.listName}>{group.name}</Text>
                        <Text style={styles.listCount}>{group.count}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : (
                  <View style={styles.dropdown}>
                    <Text style={styles.dropdownPlaceholder}>Waiting for lists from Zyn</Text>
                  </View>
                )}

                {maxWindows > 1 ? (
                  <>
                    <Text style={styles.label}>Harvesters</Text>
                    <View style={styles.workerRow}>
                      <TouchableOpacity
                        style={[styles.workerStep, (running || workers <= 1) && styles.workerStepDisabled]}
                        disabled={running || workers <= 1}
                        onPress={() => setWorkers((value) => Math.max(1, value - 1))}
                      >
                        <Text style={styles.workerStepText}>−</Text>
                      </TouchableOpacity>
                      <View style={styles.workerCount}>
                        <Text style={styles.workerCountValue}>{workers}</Text>
                        <Text style={styles.workerCountHint}>of {maxWindows}</Text>
                      </View>
                      <TouchableOpacity
                        style={[styles.workerStep, (running || workers >= maxWindows) && styles.workerStepDisabled]}
                        disabled={running || workers >= maxWindows}
                        onPress={() => setWorkers((value) => Math.min(maxWindows, value + 1))}
                      >
                        <Text style={styles.workerStepText}>+</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                ) : null}

                <View style={styles.toggleRow}>
                  <View style={styles.toggleCopy}>
                    <Text style={styles.toggleTitle}>Low Data Mode</Text>
                    <Text style={styles.toggleHint}>Skip images. Proxy Shape scripts only.</Text>
                  </View>
                  <Switch
                    value={lowData}
                    disabled={running}
                    onValueChange={setLowData}
                    trackColor={{ false: '#3a3034', true: '#E11D48' }}
                    thumbColor="#fff8f5"
                    ios_backgroundColor="#3a3034"
                  />
                </View>

                <TouchableOpacity
                  style={[styles.primary, running && styles.stop, !paired && styles.primaryDisabled]}
                  onPress={toggle}
                  disabled={!paired && !running}
                >
                  <Text style={styles.primaryText}>{running ? 'Stop' : 'Start'}</Text>
                </TouchableOpacity>

                <View style={styles.statusRow}>
                  <Text style={styles.statusLabel}>Status</Text>
                  <Text style={styles.statusValue} numberOfLines={1}>{status}</Text>
                </View>
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#161318' },
  body: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 32, gap: 14 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  headerCopy: { flex: 1, paddingRight: 12 },
  title: { color: '#fff8f5', fontSize: 28, fontWeight: '700' },
  subtitle: { color: '#a78a90', marginTop: 4, fontSize: 14 },
  muted: { color: '#a78a90', fontSize: 15, lineHeight: 22 },
  headerActions: { flexDirection: 'row', gap: 8 },
  iconChip: {
    minWidth: 48, height: 48, borderRadius: 12, backgroundColor: '#221c20',
    borderWidth: 1, borderColor: '#3a3034', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8,
  },
  iconChipValue: { color: '#fff8f5', fontWeight: '700', fontSize: 16 },
  iconBtn: {
    width: 48, height: 48, borderRadius: 12, backgroundColor: '#221c20',
    borderWidth: 1, borderColor: '#3a3034', alignItems: 'center', justifyContent: 'center',
  },
  iconBtnText: { color: '#fff8f5', fontWeight: '700', fontSize: 13 },
  welcome: { marginTop: 36, gap: 12 },
  welcomeKicker: { color: '#a78a90', fontSize: 16 },
  welcomeTitle: { color: '#fff8f5', fontSize: 34, fontWeight: '700', marginBottom: 4 },
  label: { color: '#a78a90', fontWeight: '600', fontSize: 13, marginTop: 4 },
  segmentRow: { flexDirection: 'row', gap: 10 },
  segment: {
    flex: 1, backgroundColor: '#221c20', borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', borderWidth: 1, borderColor: '#3a3034',
  },
  segmentOn: { backgroundColor: '#E11D48', borderColor: '#E11D48' },
  segmentText: { color: '#c4a8ae', fontWeight: '700', fontSize: 16 },
  segmentTextOn: { color: '#fff8f5' },
  dropdown: {
    backgroundColor: '#221c20', borderColor: '#3a3034', borderWidth: 1, borderRadius: 12,
    padding: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  dropdownValue: { color: '#fff8f5', fontWeight: '700', fontSize: 16 },
  dropdownPlaceholder: { color: '#84545c', fontWeight: '600', fontSize: 16 },
  chevron: { color: '#a78a90', fontSize: 16 },
  dropdownItem: {
    backgroundColor: '#221c20', borderColor: '#3a3034', borderWidth: 1, borderTopWidth: 0,
    padding: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  dropdownItemOn: { backgroundColor: '#2a1218' },
  listName: { color: '#fff8f5', fontWeight: '600' },
  listCount: { color: '#a78a90', fontSize: 12 },
  workerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  workerStep: {
    width: 52, height: 52, borderRadius: 12, backgroundColor: '#221c20',
    borderWidth: 1, borderColor: '#3a3034', alignItems: 'center', justifyContent: 'center',
  },
  workerStepDisabled: { opacity: 0.35 },
  workerStepText: { color: '#fff8f5', fontSize: 22, fontWeight: '700' },
  workerCount: {
    flex: 1, height: 52, borderRadius: 12, backgroundColor: '#221c20',
    borderWidth: 1, borderColor: '#3a3034', alignItems: 'center', justifyContent: 'center',
  },
  workerCountValue: { color: '#fff8f5', fontSize: 20, fontWeight: '700' },
  workerCountHint: { color: '#84545c', fontSize: 12 },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  toggleCopy: { flex: 1, paddingRight: 12 },
  toggleTitle: { color: '#c4a8ae', fontWeight: '600', fontSize: 16 },
  toggleHint: { color: '#84545c', fontSize: 12, marginTop: 2 },
  primary: {
    backgroundColor: '#E11D48', paddingVertical: 16, borderRadius: 12, alignItems: 'center', marginTop: 6,
  },
  primaryDisabled: { opacity: 0.45 },
  stop: { backgroundColor: '#7F1D1D' },
  primaryText: { color: '#fff8f5', fontWeight: '700', fontSize: 18 },
  secondary: { backgroundColor: '#221c20', padding: 14, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: '#3a3034' },
  secondaryText: { color: '#fff8f5', fontWeight: '600' },
  statusRow: {
    backgroundColor: '#221c20', borderRadius: 12, borderWidth: 1, borderColor: '#3a3034',
    paddingVertical: 16, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  statusLabel: { color: '#a78a90', fontWeight: '600', fontSize: 15 },
  statusValue: { color: '#fff8f5', fontWeight: '600', fontSize: 15, flex: 1, textAlign: 'right', marginLeft: 12 },
  scanner: { flex: 1, backgroundColor: '#000' },
  scannerOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 20, gap: 12 },
  scannerHint: { color: '#fff8f5', textAlign: 'center', fontSize: 16, fontWeight: '600' },
});
