import type { ChangeEvent } from 'react';
import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { UnigifPublicConfig, UnigifTestResult } from '../../../types/ethernet';

import buildClassName from '../../../util/buildClassName';
import { getEthernetString } from '../../../util/ethernetLang';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Island from '../../gili/layout/Island';
import Button from '../../ui/Button';
import InputText from '../../ui/InputText';
import Switcher from '../../ui/Switcher';

import styles from './SettingsEthernetUnigif.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

const SettingsEthernetUnigif = ({ isActive, onReset }: OwnProps) => {
  const { applyUnigifConfig, showNotification } = getActions();
  const lang = useLang();

  const [config, setConfig] = useState<UnigifPublicConfig>();
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<UnigifTestResult>();

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  useEffect(() => {
    void window.ethernetDesktop?.unigifGetConfig?.().then((result) => {
      setConfig(result);
      setBaseUrl(result.baseUrl);
    });
  }, []);

  const handleBaseUrlChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setBaseUrl(e.target.value);
    setTestResult(undefined);
  });

  const handleApiKeyChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setApiKey(e.target.value);
    setTestResult(undefined);
  });

  const saveConfig = useLastCallback(async (isEnabled: boolean) => {
    const setConfigRemote = window.ethernetDesktop?.unigifSetConfig;
    if (!setConfigRemote) return;

    setIsSaving(true);
    try {
      const result = await setConfigRemote({ isEnabled, baseUrl, apiKey: apiKey || undefined });
      setConfig(result);
      setBaseUrl(result.baseUrl);
      setApiKey('');
      applyUnigifConfig({ config: result });

      const isMissingConfig = isEnabled && !result.isEnabled;
      showNotification({
        message: getEthernetString(lang, isMissingConfig ? 'EthernetUnigifNeedsConfig' : 'EthernetUnigifSaved'),
      });
    } catch (err) {
      showNotification({ message: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsSaving(false);
    }
  });

  const handleToggle = useLastCallback((isChecked: boolean) => {
    void saveConfig(isChecked);
  });

  const handleSave = useLastCallback(() => {
    void saveConfig(Boolean(config?.isSwitchedOn));
  });

  const handleTest = useLastCallback(async () => {
    const test = window.ethernetDesktop?.unigifTest;
    if (!test) return;

    setIsTesting(true);
    try {
      setTestResult(await test({ baseUrl, apiKey: apiKey || undefined }));
    } finally {
      setIsTesting(false);
    }
  });

  const isSwitchedOn = Boolean(config?.isSwitchedOn);

  function renderTestResult(result: UnigifTestResult) {
    if (!result.ok) {
      return `${getEthernetString(lang, 'EthernetUnigifTestFailed')}: ${result.error}`;
    }

    const scopes = result.scopes?.join(', ');
    return `${getEthernetString(lang, 'EthernetUnigifTestOk')}: ${result.name} (${scopes})`;
  }

  return (
    <div className="settings-content custom-scroll">
      <Island className={styles.section}>
        <div className={styles.row} onClick={() => handleToggle(!isSwitchedOn)}>
          <div className={styles.titleGroup}>
            <span className={styles.titleText}>{getEthernetString(lang, 'EthernetUnigifEnable')}</span>
            <span className={styles.descText}>{getEthernetString(lang, 'EthernetUnigifHint')}</span>
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <Switcher
              id="unigif-switch"
              label={getEthernetString(lang, 'EthernetUnigifEnable')}
              checked={isSwitchedOn}
              disabled={isSaving}
              onCheck={handleToggle}
            />
          </div>
        </div>
      </Island>

      <Island className={styles.section}>
        <div className={styles.form}>
          <InputText
            id="unigif-server-url"
            label={getEthernetString(lang, 'EthernetUnigifServerUrl')}
            value={baseUrl}
            placeholder="https://gif.example.com"
            inputMode="url"
            autoComplete="off"
            onChange={handleBaseUrlChange}
          />
          <InputText
            id="unigif-api-key"
            className={styles.secretInput}
            label={getEthernetString(lang, 'EthernetUnigifApiKey')}
            value={apiKey}
            placeholder="ugf_…"
            autoComplete="off"
            onChange={handleApiKeyChange}
          />
          {config?.hasApiKey && !apiKey && (
            <span className={styles.descText}>{getEthernetString(lang, 'EthernetUnigifApiKeySaved')}</span>
          )}

          {testResult && (
            <div className={buildClassName(styles.testResult, testResult.ok ? styles.testOk : styles.testFailed)}>
              {renderTestResult(testResult)}
            </div>
          )}

          <div className={styles.actions}>
            <Button size="smaller" color="translucent" isLoading={isTesting} onClick={handleTest}>
              {getEthernetString(lang, isTesting ? 'EthernetUnigifTesting' : 'EthernetUnigifTest')}
            </Button>
            <Button size="smaller" isLoading={isSaving} onClick={handleSave}>
              {getEthernetString(lang, 'EthernetUnigifSave')}
            </Button>
          </div>
        </div>
      </Island>
    </div>
  );
};

export default memo(SettingsEthernetUnigif);
