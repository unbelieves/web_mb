<script setup lang="ts">
import { computed, ref } from 'vue';
import type { FieldDefinition } from '../model/device';

const props = defineProps<{
  field: FieldDefinition;
  modelValue: string;
  status: string;
  disabled: boolean;
  error?: string;
  allowWrite?: boolean;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: string];
  read: [field: FieldDefinition];
  write: [field: FieldDefinition];
}>();
const reveal = ref(false);
const unavailable = computed(() => props.field.available === false);
const secret = computed(() => /password|secret|cardkey/i.test(props.field.key));
const hasValue = computed(() => ['read', 'written', 'edited'].includes(props.status));
const displayValue = computed(() => {
  if (unavailable.value) return '固件不支持';
  if (props.status === 'error') return '读取失败';
  if (!hasValue.value) return '—';
  if (props.field.options) {
    const option = props.field.options.find(item => String(item.value) === props.modelValue);
    return option?.label ?? `未知 (${props.modelValue})`;
  }
  if (props.field.kind === 'bool') return props.modelValue === '1' ? '开启' : '关闭';
  return props.modelValue || '（空）';
});
const parameter = computed(() => String(props.field.address + 1).padStart(4, '0'));
const statusText = computed(() => ({
  unread: '未读取', reading: '读取中', read: '已读取', written: '已写入',
  edited: '待写入', error: '失败', unavailable: '不可用',
}[props.status] ?? '未读取'));
const numeric = computed(() => ['u16', 'u32', 'float', 'scaled10'].includes(props.field.kind));
const inputMode = computed(() => ['u16', 'u32'].includes(props.field.kind) ? 'numeric' : 'decimal');

function update(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement | HTMLSelectElement).value);
}
</script>

<template>
  <div class="device-field" :class="{ 'field-error': !!error || status === 'error', 'field-unavailable': unavailable }">
    <div class="field-heading">
      <label :for="`field-${field.key}`" class="field-label">{{ field.label }}</label>
      <span class="field-state" :class="`field-state-${status}`">{{ statusText }}</span>
    </div>
    <div class="field-control-row">
      <template v-if="field.writable && !unavailable">
        <select
          v-if="field.kind === 'enum'"
          :id="`field-${field.key}`"
          :value="modelValue"
          :disabled="disabled"
          :aria-invalid="!!error"
          @change="update"
        >
          <option value="" disabled>请选择 / 先读取</option>
          <option v-for="option in field.options" :key="option.value" :value="String(option.value)">{{ option.label }}</option>
        </select>
        <label v-else-if="field.kind === 'bool'" class="boolean-control" :for="`field-${field.key}`">
          <input
            :id="`field-${field.key}`"
            type="checkbox"
            :checked="modelValue === '1'"
            :disabled="disabled"
            @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked ? '1' : '0')"
          />
          <span>{{ modelValue === '1' ? '启用' : '停用' }}</span>
        </label>
        <div v-else class="text-control" :class="{ 'secret-control': secret }">
          <input
            :id="`field-${field.key}`"
            :type="secret && !reveal ? 'password' : 'text'"
            :inputmode="numeric ? inputMode : 'text'"
            :value="modelValue"
            :disabled="disabled"
            :aria-invalid="!!error"
            :placeholder="status === 'error' ? '读取失败，可手动填写' : '未读取'"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            @input="update"
          />
          <button v-if="secret" type="button" class="reveal-button" :aria-label="`${reveal ? '隐藏' : '显示'}${field.label}`" :aria-pressed="reveal" @click="reveal = !reveal">{{ reveal ? '隐藏' : '显示' }}</button>
        </div>
      </template>
      <output v-else :id="`field-${field.key}`" class="field-output" :class="{ 'field-output-alarms': field.kind === 'alarms' }">{{ displayValue }}</output>
      <span v-if="field.unit" class="field-unit">{{ field.unit }}</span>
      <button v-if="!unavailable" type="button" class="field-read-button" :disabled="disabled" :aria-label="`读取${field.label}`" @click="emit('read', field)">读取</button>
      <button v-if="allowWrite && field.writable && !unavailable" type="button" class="button button-small button-primary" :disabled="disabled" @click="emit('write', field)">写入</button>
    </div>
    <div class="field-meta"><span>参数 {{ parameter }}</span><span>地址 {{ field.address }} · {{ field.count }} 寄存器</span></div>
    <p v-if="field.note" class="field-note">{{ field.note }}</p>
    <p v-if="error" class="field-error-message" :id="`error-${field.key}`">{{ error }}</p>
  </div>
</template>
