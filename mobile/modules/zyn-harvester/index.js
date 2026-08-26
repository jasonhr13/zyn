import { NativeModules } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

export default requireOptionalNativeModule('ZynHarvester') || NativeModules.ZynHarvester || null;
