import { ArrowLineDown, Barcode, CreditCard, MagnifyingGlass, QrCode, DoorOpen, Eject, HandTap, LinkBreak, Password, Play, ReceiptX, Scissors, ThermometerHot, Vault, WarningDiamond, XCircle, type Icon } from '@phosphor-icons/react';
import { TEST_BARCODES, type PrinterFault, type PrinterSnapshot, type ScannerSnapshot, type TerminalSnapshot } from '../../shared/contract.ts';
import { Tool } from '../components/ui.tsx';
import { api, scannerApi, terminalApi } from '../store.ts';

const FAULT_TOOLS: [PrinterFault, string, Icon][] = [
  ['coverOpen', 'Cover open', DoorOpen],
  ['paperOut', 'Paper out', ReceiptX],
  ['paperNearEnd', 'Paper low', WarningDiamond],
  ['headOverheat', 'Print head hot', ThermometerHot],
];

/** Test tools floating over the scene for the focused printer: what a technician would do at the bench. */
export function DeviceTools({ printer }: { printer: PrinterSnapshot }) {
  const id = printer.config.id;
  const { faults } = printer.status;
  return (
    <div className="vp-dock" role="toolbar" aria-label={`Tools for ${printer.config.name}`}>
      <Tool icon={Play} label="Test receipt" className="tool-primary" onClick={() => api.action(id, 'self-test')} />
      <Tool icon={ArrowLineDown} label="FEED" onClick={() => api.action(id, 'feed')} />
      <Tool icon={Scissors} label="Tear off paper" disabled={!printer.paper} onClick={() => api.action(id, 'tear-off')} />
      <span className="vp-sep" aria-hidden="true" />
      {FAULT_TOOLS.map(([fault, label, icon]) => (
        <Tool key={fault} icon={icon} label={label} className="tool-fault" pressed={faults[fault]} onClick={() => api.setFaults(id, { [fault]: !faults[fault] })} />
      ))}
    </div>
  );
}

/** The cashier's hands on the drawer. `printer` is the one it is wired to (it holds the drawer's state). */
export function DrawerTools({ printer }: { printer: PrinterSnapshot }) {
  const open = printer.status.drawerOpen;
  return (
    <div className="vp-dock" role="toolbar" aria-label="Cash drawer tools">
      <Tool icon={Vault} label={open ? 'Close drawer' : 'Open with key'} className="tool-primary" pressed={open} onClick={() => api.setDrawer(printer.config.id, !open)} />
    </div>
  );
}

/** The shopper's hands at the terminal, plus the network fault. */
export function TerminalTools({ terminal }: { terminal: TerminalSnapshot }) {
  const id = terminal.config.id;
  const { screen, cardInserted, behaviour } = terminal.status;
  const waiting = screen.phase === 'card';
  const pin = screen.phase === 'pin' && screen.message === 'Enter PIN';
  const typePin = async () => {
    for (const key of ['1', '2', '3', '4', 'enter']) await terminalApi.key(id, key);
  };
  return (
    <div className="vp-dock" role="toolbar" aria-label={`Tools for ${terminal.config.name}`}>
      <Tool icon={HandTap} label="Tap Visa (contactless)" className="tool-primary" disabled={!waiting} onClick={() => terminalApi.present(id, 'visa', 'Contactless')} />
      <Tool icon={CreditCard} label="Insert Maestro (chip)" disabled={!waiting} onClick={() => terminalApi.present(id, 'maestro', 'ICC')} />
      <Tool icon={Password} label="Enter PIN 1234" disabled={!pin} onClick={typePin} />
      <Tool icon={XCircle} label="Cancel on terminal" disabled={!['card', 'reading', 'pin'].includes(screen.phase)} onClick={() => terminalApi.key(id, 'cancel')} />
      <Tool icon={Eject} label="Remove card" disabled={!cardInserted} onClick={() => terminalApi.removeCard(id)} />
      <span className="vp-sep" aria-hidden="true" />
      <Tool icon={LinkBreak} label="Drop response" className="tool-fault" pressed={behaviour.responseLost} onClick={() => terminalApi.setBehaviour(id, { responseLost: !behaviour.responseLost })} />
    </div>
  );
}

/** Trigger shortcuts: the products on the bench can also be clicked in the scene. */
export function ScannerTools({ scanner }: { scanner: ScannerSnapshot }) {
  const { id, enabled } = scanner.config;
  const busy = scanner.status.scanning !== null || !enabled;
  const scan = (barcode: (typeof TEST_BARCODES)[number]['id']) => scannerApi.scan(id, TEST_BARCODES.find((b) => b.id === barcode)!.data);
  return (
    <div className="vp-dock" role="toolbar" aria-label={`Tools for ${scanner.config.name}`}>
      <Tool icon={Barcode} label="Scan water (EAN-13)" className="tool-primary" disabled={busy} onClick={() => scan('water')} />
      <Tool icon={Barcode} label="Scan internal label (Code 128)" disabled={busy} onClick={() => scan('sku')} />
      <Tool icon={QrCode} label="Scan QR coupon" disabled={busy} onClick={() => scan('coupon')} />
      <span className="vp-sep" aria-hidden="true" />
      <Tool icon={MagnifyingGlass} label="Find POS window" onClick={() => scannerApi.probe(id)} />
    </div>
  );
}
